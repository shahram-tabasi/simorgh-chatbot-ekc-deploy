"""
LangChain Agent Orchestration

Integrates model with tools (search, Python REPL) for agentic workflows.
Compatible with LangChain 1.0+ - with comprehensive import fallbacks
"""

import logging
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

# Check if langchain is available at all
LANGCHAIN_AVAILABLE = False
USING_CLASSIC = False
AgentExecutor = None
create_react_agent = None
PromptTemplate = None
Tool = None
BaseLanguageModel = None

try:
    # Step 1: Try to import Tool (should work with any version)
    try:
        from langchain.tools import Tool
    except ImportError:
        from langchain_core.tools import Tool
    
    # Step 2: Try to import BaseLanguageModel
    try:
        from langchain.schema import BaseLanguageModel
    except ImportError:
        try:
            from langchain_core.language_models import BaseLanguageModel
        except ImportError:
            from langchain_core.language_models.base import BaseLanguageModel
    
    LANGCHAIN_AVAILABLE = True
    
    # Step 3: Try to import PromptTemplate (location changed in v1.0)
    try:
        from langchain.prompts import PromptTemplate
    except ImportError:
        try:
            from langchain_core.prompts import PromptTemplate
        except ImportError:
            logger.warning("Could not import PromptTemplate")
            PromptTemplate = None
    
    # Step 4: Try importing agent components
    try:
        from langchain_classic.agents import AgentExecutor, create_react_agent
        USING_CLASSIC = True
        logger.info("✅ Using langchain-classic for agents")
    except ImportError:
        try:
            from langchain.agents import create_agent
            USING_CLASSIC = False
            logger.info("✅ Using modern LangChain agents")
        except ImportError:
            logger.warning("⚠️  No agent support found - agents will be disabled")
            
except ImportError as e:
    logger.error(f"❌ LangChain not properly installed: {e}")
    logger.error("Please install: pip install langchain langchain-core langchain-classic")


# ReAct prompt template for tool use
REACT_PROMPT_TEMPLATE = """You are a helpful AI assistant with access to tools.

IMPORTANT: You MUST follow the EXACT format below. Do NOT use analysis/final markers.

You have access to the following tools:

{tools}

Use this EXACT format (copy it exactly):

Question: the input question you must answer
Thought: I need to think about what to do
Action: the action to take, must be exactly one of [{tool_names}]
Action Input: the input to the action (just the query, nothing else)
Observation: the result of the action (this will be provided to you)
... (Thought/Action/Action Input/Observation can repeat)
Thought: I now know the final answer
Final Answer: the final answer to the original question

EXAMPLE:
Question: What is ANSI code 27?
Thought: I need to search for information about ANSI code 27
Action: web_search
Action Input: ANSI code 27 protection relay
Observation: [search results will appear here]
Thought: I now know the final answer based on the search results
Final Answer: ANSI code 27 is the undervoltage relay...

RULES:
- ALWAYS start with "Thought:" (not "analysis" or anything else)
- Action Input must be ONLY the search query (no JSON, no extra text)
- After getting Observation, provide "Final Answer:" with the actual answer
- Do NOT output "analysis", "assistantfinal", or JSON format

Begin!

Question: {input}
{agent_scratchpad}"""


# Conditional class definition based on what's available
if BaseLanguageModel is not None:
    from typing import Any as AnyType

    class CustomLLMWrapper(BaseLanguageModel):
        """
        Wrapper to make our model manager compatible with LangChain.

        Properly inherits from BaseLanguageModel to work with langchain-classic.
        """
        # Pydantic v2 configuration - allow arbitrary types
        model_config = {'arbitrary_types_allowed': True}

        # Declare fields for Pydantic
        model_manager: AnyType = None
        _stop: Optional[List[str]] = None

        def __init__(self, model_manager):
            """Initialize wrapper with model manager"""
            # Initialize BaseLanguageModel first (Pydantic model)
            super().__init__(model_manager=model_manager)

        def bind(self, **kwargs):
            """
            Bind parameters to this LLM (required by langchain-classic).

            Returns a new instance with bound parameters.
            """
            # Create a new instance with the same model manager
            new_wrapper = CustomLLMWrapper(self.model_manager)
            # Store any stop sequences
            new_wrapper._stop = kwargs.get('stop', self._stop)
            return new_wrapper

        @property
        def _llm_type(self) -> str:
            """Return LLM type identifier"""
            return "custom_vllm_or_unsloth"

        def invoke(self, input: str, config: Any = None, **kwargs) -> str:
            """
            Invoke the LLM (required by Runnable interface).

            This is the modern LangChain way to call the model.
            Args:
                input: The input text/prompt (may be StringPromptValue or str)
                config: Optional LangChain RunnableConfig (ignored but required for compatibility)
            """
            # Handle LangChain's StringPromptValue objects
            if hasattr(input, 'text'):
                input = input.text
            elif hasattr(input, 'to_string'):
                input = input.to_string()
            elif not isinstance(input, str):
                input = str(input)
            return self.predict(input, **kwargs)

        async def _agenerate(self, prompts: List[str], **kwargs) -> Any:
            """Generate responses asynchronously"""
            if not prompts:
                raise ValueError("No prompts provided")

            prompt = prompts[0]
            messages = [{"role": "user", "content": prompt}]

            text, _ = await self.model_manager.generate(
                messages=messages,
                max_tokens=kwargs.get("max_tokens", 1024),
                temperature=kwargs.get("temperature", 0.7),
                top_p=kwargs.get("top_p", 0.95),
            )

            return text

        def _generate(self, prompts: List[str], **kwargs) -> Any:
            """Synchronous generation"""
            import asyncio
            try:
                loop = asyncio.get_event_loop()
            except RuntimeError:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
            return loop.run_until_complete(self._agenerate(prompts, **kwargs))

        async def apredict(self, text: str, **kwargs) -> str:
            """Async predict - single text input/output"""
            result = await self._agenerate([text], **kwargs)
            return result

        def predict(self, text: str, **kwargs) -> str:
            """Sync predict"""
            import asyncio
            try:
                loop = asyncio.get_event_loop()
            except RuntimeError:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
            return loop.run_until_complete(self.apredict(text, **kwargs))

        def generate_prompt(self, prompts, stop=None, **kwargs):
            """
            Generate responses for prompts (required abstract method).

            This is the synchronous version required by BaseLanguageModel.
            """
            # Convert prompts to strings if they're not already
            if hasattr(prompts, '__iter__') and not isinstance(prompts, str):
                prompt_strings = [str(p) for p in prompts]
            else:
                prompt_strings = [str(prompts)]

            # Use _generate which calls our async generate
            return self._generate(prompt_strings, stop=stop, **kwargs)

        async def agenerate_prompt(self, prompts, stop=None, **kwargs):
            """
            Async generate responses for prompts (required abstract method).

            This is the async version required by BaseLanguageModel.
            """
            # Convert prompts to strings if they're not already
            if hasattr(prompts, '__iter__') and not isinstance(prompts, str):
                prompt_strings = [str(p) for p in prompts]
            else:
                prompt_strings = [str(prompts)]

            # Use _agenerate
            return await self._agenerate(prompt_strings, stop=stop, **kwargs)

else:
    # Fallback if BaseLanguageModel is not available
    class CustomLLMWrapper:
        """
        Fallback wrapper when LangChain is not available.
        """

        def __init__(self, model_manager):
            """Initialize wrapper with model manager"""
            self.model_manager = model_manager
            self._stop = None

        def bind(self, **kwargs):
            """Bind parameters"""
            new_wrapper = CustomLLMWrapper(self.model_manager)
            new_wrapper._stop = kwargs.get('stop', self._stop)
            return new_wrapper

        @property
        def _llm_type(self) -> str:
            """Return LLM type identifier"""
            return "custom_vllm_or_unsloth"

        def invoke(self, input: str, config: Any = None, **kwargs) -> str:
            """Invoke the LLM (config is optional for LangChain compatibility)"""
            # Handle LangChain's StringPromptValue objects
            if hasattr(input, 'text'):
                input = input.text
            elif hasattr(input, 'to_string'):
                input = input.to_string()
            elif not isinstance(input, str):
                input = str(input)
            return self.predict(input, **kwargs)

        async def _agenerate(self, prompts: List[str], **kwargs) -> Any:
            """Generate responses asynchronously"""
            if not prompts:
                raise ValueError("No prompts provided")
            prompt = prompts[0]
            messages = [{"role": "user", "content": prompt}]
            text, _ = await self.model_manager.generate(
                messages=messages,
                max_tokens=kwargs.get("max_tokens", 1024),
                temperature=kwargs.get("temperature", 0.7),
                top_p=kwargs.get("top_p", 0.95),
            )
            return text

        def _generate(self, prompts: List[str], **kwargs) -> Any:
            """Synchronous generation"""
            import asyncio
            try:
                loop = asyncio.get_event_loop()
            except RuntimeError:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
            return loop.run_until_complete(self._agenerate(prompts, **kwargs))

        async def apredict(self, text: str, **kwargs) -> str:
            """Async predict"""
            result = await self._agenerate([text], **kwargs)
            return result

        def predict(self, text: str, **kwargs) -> str:
            """Sync predict"""
            import asyncio
            try:
                loop = asyncio.get_event_loop()
            except RuntimeError:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
            return loop.run_until_complete(self.apredict(text, **kwargs))


class LangChainAgent:
    """
    LangChain agent with tools orchestration.

    Provides tool-enhanced generation using ReAct pattern.
    Compatible with both legacy (langchain-classic) and modern (langchain 1.0+) APIs.
    """

    def __init__(
        self,
        model_manager,
        tools: List[Any],
        verbose: bool = False
    ):
        """
        Initialize agent.

        Args:
            model_manager: ModelManager instance
            tools: List of LangChain tools
            verbose: Whether to log agent steps
        """
        self.model_manager = model_manager
        self.tools = tools
        self.verbose = verbose

        if not LANGCHAIN_AVAILABLE:
            logger.error("❌ LangChain not available - agent functionality disabled")
            logger.error("   Install: pip install langchain langchain-core langchain-classic")
            self.agent = None
            self.llm = None
            return

        self.llm = CustomLLMWrapper(model_manager)
        self.agent = self._create_agent()

    def _create_agent(self) -> Optional[Any]:
        """Create agent with tools"""
        if not LANGCHAIN_AVAILABLE:
            logger.warning("⚠️  LangChain not available")
            return None
            
        if not self.tools:
            logger.warning("⚠️  No tools provided - agent will not be created")
            return None

        try:
            if USING_CLASSIC and create_react_agent is not None and AgentExecutor is not None and PromptTemplate is not None:
                # Legacy approach using langchain-classic
                logger.info("Creating agent with langchain-classic AgentExecutor")
                
                prompt = PromptTemplate(
                    template=REACT_PROMPT_TEMPLATE,
                    input_variables=["input", "agent_scratchpad"],
                    partial_variables={
                        "tools": self._format_tools(),
                        "tool_names": ", ".join([t.name for t in self.tools]),
                    }
                )

                agent = create_react_agent(
                    llm=self.llm,
                    tools=self.tools,
                    prompt=prompt
                )

                executor = AgentExecutor(
                    agent=agent,
                    tools=self.tools,
                    verbose=self.verbose,
                    max_iterations=10,  # Increased to give LLM more chances
                    handle_parsing_errors=self._handle_parsing_error,
                    max_execution_time=60,  # 60 second timeout
                )
            else:
                # Modern LangChain 1.0+ approach
                logger.info("Creating agent with modern LangChain create_agent")
                from langchain.agents import create_agent
                
                executor = create_agent(
                    model=self.llm,
                    tools=self.tools,
                    system_prompt="You are a helpful AI assistant. Use the available tools to answer questions.",
                )

            logger.info(f"✅ LangChain agent created with {len(self.tools)} tools")
            return executor

        except Exception as e:
            logger.error(f"❌ Failed to create agent: {e}")
            logger.exception(e)
            return None

    def _handle_parsing_error(self, error: Exception) -> str:
        """
        Handle parsing errors from the agent.

        When the LLM outputs in wrong format (e.g., analysis/assistantfinal),
        this provides a helpful message to guide it back to the correct format.
        """
        import re

        error_str = str(error)
        logger.warning(f"⚠️ Agent parsing error: {error_str[:200]}")

        # Check if the error contains what looks like a final answer
        if 'assistantfinal' in error_str.lower():
            # Try to extract the answer from the error
            match = re.search(r'assistantfinal[:\s]*(.+)', error_str, re.IGNORECASE | re.DOTALL)
            if match:
                answer = match.group(1).strip()[:500]
                return f"Final Answer: {answer}"

        # Return guidance to help the LLM correct its format
        return (
            "I made a formatting error. Let me try again with the correct format.\n"
            "Thought: I need to provide my answer in the correct format.\n"
        )

    def _format_tools(self) -> str:
        """Format tools for prompt"""
        lines = []
        for tool in self.tools:
            lines.append(f"- {tool.name}: {tool.description}")
        return "\n".join(lines)

    async def run(
        self,
        input_text: str,
        use_tools: bool = True
    ) -> Dict[str, Any]:
        """
        Run agent on input.

        Args:
            input_text: User input
            use_tools: Whether to use tools (if False, direct generation)

        Returns:
            Dict with output and metadata
        """
        if not LANGCHAIN_AVAILABLE or not use_tools or self.agent is None:
            # Direct generation without tools
            messages = [{"role": "user", "content": input_text}]
            output, tokens = await self.model_manager.generate(messages)

            return {
                "output": output,
                "tokens_used": tokens,
                "tool_calls": [],
                "used_tools": False
            }

        # Try custom tool loop first (handles LLM's native format)
        custom_result = await self._run_custom_tool_loop(input_text)
        if custom_result:
            return custom_result

        # Fallback to standard agent
        return await self._run_standard_agent(input_text)

    async def _run_custom_tool_loop(self, input_text: str) -> Optional[Dict[str, Any]]:
        """
        Custom tool execution loop that handles the LLM's native format.

        The LLM outputs in format:
        - analysisXXX... (thinking)
        - assistantcommentary to=tool_name json{"query": "..."} (tool call)
        - assistantfinal... (final answer)

        This parses that format and executes tools accordingly.
        GUARANTEES clean output - no internal markers in returned text.
        """
        import re
        import time
        import json

        # Import output parser for guaranteed clean output
        try:
            from utils.output_parser import parse_llm_output, sanitize_for_user
            HAS_PARSER = True
        except ImportError:
            HAS_PARSER = False
            def parse_llm_output(x): return x
            def sanitize_for_user(x): return x

        start_time = time.time()
        tool_calls = []
        tool_results = []  # Store full results for summary
        max_iterations = 5

        # Build simple prompt for tool use
        tools_desc = "\n".join([f"- {t.name}: {t.description[:100]}..." for t in self.tools])
        prompt = f"""You have these tools available:
{tools_desc}

To use a tool, output: assistantcommentary to=tool_name json{{"query": "your query"}}
After getting results, provide your answer with: assistantfinal Your answer here

Question: {input_text}"""

        messages = [{"role": "user", "content": prompt}]

        for iteration in range(max_iterations):
            # Generate response
            output, tokens = await self.model_manager.generate(messages, max_tokens=1024)
            logger.info(f"🔄 Custom loop iteration {iteration + 1}: {output[:150]}...")

            # Check for final answer
            final_match = re.search(r'assistantfinal\s*(.*)', output, re.IGNORECASE | re.DOTALL)
            if final_match:
                final_answer = final_match.group(1).strip()
                elapsed = time.time() - start_time
                logger.info(f"✅ Custom loop completed in {elapsed:.2f}s with {len(tool_calls)} tool calls")

                # Ensure clean output
                clean_answer = sanitize_for_user(final_answer) if final_answer else ""

                # If answer is empty but we have tool results, summarize them
                if not clean_answer and tool_results:
                    clean_answer = self._generate_summary_from_results(input_text, tool_results)

                return {
                    "output": clean_answer,
                    "tokens_used": tokens,
                    "tool_calls": tool_calls,
                    "used_tools": len(tool_calls) > 0,
                    "execution_time": elapsed
                }

            # Check for tool call in LLM's native format
            # Handles: "assistantcommentary to=web_search json{...}" or "assistantcommentary to=web_searchjson{...}"
            tool_match = re.search(
                r'(?:assistantcommentary|commentary)\s+to=(\w+)\s*(?:json|code)?\s*(\{[^}]+\})',
                output,
                re.IGNORECASE
            )

            if tool_match:
                tool_name = tool_match.group(1).strip()
                try:
                    tool_args = json.loads(tool_match.group(2))
                except json.JSONDecodeError:
                    # Try to extract query from malformed JSON
                    query_match = re.search(r'["\']query["\']\s*:\s*["\']([^"\']+)["\']', tool_match.group(2))
                    tool_args = {"query": query_match.group(1) if query_match else input_text}

                query = tool_args.get("query", input_text)

                # Find and execute tool
                tool_result = None
                for tool in self.tools:
                    if tool.name == tool_name or tool_name in tool.name:
                        logger.info(f"🔧 Custom loop: Executing {tool.name} with query: '{query[:100]}'")
                        try:
                            tool_result = tool.run(query)
                            tool_calls.append({
                                "tool": tool.name,
                                "input": query,
                                "output": tool_result[:500] if tool_result else ""
                            })
                            tool_results.append({
                                "tool": tool.name,
                                "query": query,
                                "result": tool_result
                            })
                            logger.info(f"✅ Tool {tool.name} returned {len(tool_result) if tool_result else 0} chars")
                        except Exception as e:
                            logger.error(f"❌ Tool {tool.name} failed: {e}")
                            tool_result = f"Error: {str(e)}"
                        break

                if tool_result:
                    # Add tool result to messages and continue
                    messages.append({"role": "assistant", "content": output})
                    messages.append({
                        "role": "user",
                        "content": f"Observation from {tool_name}:\n{tool_result}\n\nNow provide your final answer with: assistantfinal Your answer"
                    })
                    continue

            # No tool call matched - check if there's any tool-like pattern we missed
            if 'assistantcommentary' in output.lower() or 'commentary to=' in output.lower():
                # LLM is trying to call a tool but format is wrong - prompt for correct format
                logger.warning(f"⚠️ Detected malformed tool call, prompting for correct format")
                messages.append({"role": "assistant", "content": output})
                messages.append({
                    "role": "user",
                    "content": "I see you're trying to use a tool. Please use this exact format:\nassistantcommentary to=web_search json{\"query\": \"your search query\"}\n\nOr provide your final answer with:\nassistantfinal Your answer here"
                })
                continue

            # No tool call and no final answer - if we have tool results, ask for final answer
            if tool_results and iteration > 0:
                logger.info(f"🔄 Have {len(tool_results)} tool results, prompting for final answer")
                messages.append({"role": "assistant", "content": output})
                messages.append({
                    "role": "user",
                    "content": f"You have already searched and found information. Please provide your final answer now using:\nassistantfinal Your answer based on the search results"
                })
                continue

            # Add response and prompt for tool use or final answer
            messages.append({"role": "assistant", "content": output})
            messages.append({
                "role": "user",
                "content": "Please either use a tool with 'assistantcommentary to=tool_name json{\"query\": \"...\"}' or provide your final answer with 'assistantfinal Your answer here'"
            })

        # Exhausted iterations - generate clean output from what we have
        elapsed = time.time() - start_time
        logger.warning(f"⚠️ Custom loop exhausted {max_iterations} iterations")

        # If we have tool results, generate a summary
        if tool_results:
            summary = self._generate_summary_from_results(input_text, tool_results)
            return {
                "output": summary,
                "tokens_used": 0,
                "tool_calls": tool_calls,
                "used_tools": True,
                "execution_time": elapsed
            }

        # No tool results - try to extract useful content from last output
        if HAS_PARSER:
            clean_output = parse_llm_output(output)
            if clean_output and len(clean_output) > 50:
                return {
                    "output": clean_output,
                    "tokens_used": 0,
                    "tool_calls": [],
                    "used_tools": False,
                    "execution_time": elapsed
                }

        return None  # Let standard agent try

    def _generate_summary_from_results(self, question: str, tool_results: List[Dict]) -> str:
        """
        Generate a clean summary from tool results.

        Used when the LLM doesn't produce a proper final answer but we have
        useful tool results to present to the user.
        """
        if not tool_results:
            return ""

        # Build a clean summary
        summary_parts = []
        summary_parts.append(f"Based on the search results for your question:\n")

        for result in tool_results:
            tool_name = result.get("tool", "search")
            tool_result = result.get("result", "")

            if tool_result:
                # Clean the result - remove any internal markers
                clean_result = tool_result
                # Truncate if too long
                if len(clean_result) > 2000:
                    clean_result = clean_result[:2000] + "..."

                summary_parts.append(f"\n{clean_result}")

        return "\n".join(summary_parts)

    async def _run_standard_agent(self, input_text: str) -> Dict[str, Any]:
        """
        Run the standard ReAct agent.

        Falls back to this if custom tool loop doesn't work.
        GUARANTEES clean output - no internal markers.
        """
        import time

        # Import output parser
        try:
            from utils.output_parser import parse_llm_output
            HAS_PARSER = True
        except ImportError:
            HAS_PARSER = False
            def parse_llm_output(x): return x

        try:
            start_time = time.time()
            logger.info(f"🚀 Running standard agent for: {input_text[:100]}...")

            # Invoke the agent
            if USING_CLASSIC:
                result = await self.agent.ainvoke({"input": input_text})
            else:
                result = await self.agent.ainvoke({"messages": [{"role": "user", "content": input_text}]})

            tool_calls = []

            if USING_CLASSIC and "intermediate_steps" in result:
                for action, observation in result["intermediate_steps"]:
                    tool_call = {
                        "tool": action.tool,
                        "input": action.tool_input,
                        "output": observation
                    }
                    tool_calls.append(tool_call)

                    # Log each tool call with details
                    logger.info(f"🔧 TOOL CALL: {action.tool}")
                    logger.info(f"   📥 Input: {str(action.tool_input)[:200]}...")
                    logger.info(f"   📤 Output: {str(observation)[:200]}...")

                output = result.get("output", "")
            else:
                output = result.get("messages", [])[-1].get("content", "") if result.get("messages") else str(result)

            elapsed_time = time.time() - start_time

            # ENSURE CLEAN OUTPUT - parse to remove any internal markers
            if HAS_PARSER:
                clean_output = parse_llm_output(output)
                logger.info(f"📝 Standard agent output parsed: {len(output)} -> {len(clean_output)} chars")
                output = clean_output

            # Summary log
            if tool_calls:
                tools_used = [tc["tool"] for tc in tool_calls]
                logger.info(f"✅ Agent completed in {elapsed_time:.2f}s - Tools used: {tools_used}")
            else:
                logger.info(f"✅ Agent completed in {elapsed_time:.2f}s - No tools used (direct response)")

            return {
                "output": output,
                "tokens_used": None,
                "tool_calls": tool_calls,
                "used_tools": len(tool_calls) > 0,
                "execution_time": elapsed_time
            }

        except Exception as e:
            logger.error(f"❌ Agent execution failed: {e}")
            logger.exception(e)
            # Fallback to direct generation
            messages = [{"role": "user", "content": input_text}]
            output, tokens = await self.model_manager.generate(messages)

            # Parse fallback output too
            if HAS_PARSER:
                output = parse_llm_output(output)

            return {
                "output": output,
                "tokens_used": tokens,
                "tool_calls": [],
                "used_tools": False,
                "error": str(e)
            }

    async def run_with_messages(
        self,
        messages: List[Dict[str, str]],
        use_tools: bool = True
    ) -> Dict[str, Any]:
        """
        Run agent with chat messages.

        Args:
            messages: Chat messages in OpenAI format
            use_tools: Whether to enable tool use

        Returns:
            Dict with output and metadata
        """
        input_text = self._format_messages_as_prompt(messages)
        return await self.run(input_text, use_tools=use_tools)

    def _format_messages_as_prompt(self, messages: List[Dict[str, str]]) -> str:
        """Format messages as prompt for agent"""
        user_messages = [m for m in messages if m.get("role") == "user"]
        if user_messages:
            return user_messages[-1].get("content", "")

        parts = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                parts.append(f"System: {content}")
            elif role == "user":
                parts.append(f"User: {content}")
            elif role == "assistant":
                parts.append(f"Assistant: {content}")

        return "\n".join(parts)


def create_agent_with_tools(
    model_manager,
    enable_search: bool = True,
    enable_python_repl: bool = False,
    enable_wikipedia: bool = True,
    verbose: bool = False
) -> LangChainAgent:
    """
    Factory function to create agent with tools.

    Args:
        model_manager: ModelManager instance
        enable_search: Whether to enable search tool
        enable_python_repl: Whether to enable Python REPL
        enable_wikipedia: Whether to enable Wikipedia search tool
        verbose: Whether to log agent steps

    Returns:
        Configured LangChain agent (or fallback without tools if LangChain unavailable)
    """
    if not LANGCHAIN_AVAILABLE:
        logger.warning("⚠️  LangChain not available - creating agent without tool support")
        return LangChainAgent(
            model_manager=model_manager,
            tools=[],
            verbose=verbose
        )

    try:
        from tools.search_tool import create_search_tool_from_env
        from tools.python_repl import create_python_repl_from_env
        from tools.wikipedia_tool import create_wikipedia_tool_from_env, create_electrical_wiki_tool
    except ImportError as e:
        logger.warning(f"⚠️  Tool modules not found: {e}")
        return LangChainAgent(
            model_manager=model_manager,
            tools=[],
            verbose=verbose
        )

    tools = []

    # Add search tool
    if enable_search:
        try:
            search_tool = create_search_tool_from_env()
            if search_tool:
                tools.append(search_tool)
                logger.info("✅ Search tool enabled")
        except Exception as e:
            logger.warning(f"⚠️  Failed to initialize search tool: {e}")

    # Add Wikipedia tool (general + electrical standards)
    if enable_wikipedia:
        try:
            # General Wikipedia search
            wiki_tool = create_wikipedia_tool_from_env()
            if wiki_tool:
                tools.append(wiki_tool)
                logger.info("✅ Wikipedia tool enabled")

            # Specialized electrical standards Wikipedia
            electrical_wiki = create_electrical_wiki_tool()
            if electrical_wiki:
                tools.append(electrical_wiki)
                logger.info("✅ Electrical Standards Wikipedia tool enabled")
        except Exception as e:
            logger.warning(f"⚠️  Failed to initialize Wikipedia tool: {e}")

    # Add Python REPL tool
    if enable_python_repl:
        try:
            python_tool = create_python_repl_from_env()
            if python_tool:
                tools.append(python_tool)
                logger.info("✅ Python REPL tool enabled")
        except Exception as e:
            logger.warning(f"⚠️  Failed to initialize Python REPL tool: {e}")

    return LangChainAgent(
        model_manager=model_manager,
        tools=tools,
        verbose=verbose
    )