"""
LangChain Agent Orchestration

Integrates model with tools (search, Python REPL) for agentic workflows.
Compatible with LangChain 1.0+
"""

import logging
from typing import List, Dict, Any, Optional

# For LangChain 1.0+, AgentExecutor is in langchain-classic
# Option 1: Use langchain-classic (legacy support)
try:
    from langchain_classic.agents import AgentExecutor, create_react_agent
    USING_CLASSIC = True
except ImportError:
    # Option 2: Use the new simplified agent API
    try:
        from langchain.agents import create_agent
        USING_CLASSIC = False
        AgentExecutor = None
        create_react_agent = None
    except ImportError:
        # Fallback: Try old imports for pre-1.0 versions
        from langchain.agents import AgentExecutor, create_react_agent
        USING_CLASSIC = True

from langchain.prompts import PromptTemplate
from langchain.tools import Tool
from langchain.schema import BaseLanguageModel

logger = logging.getLogger(__name__)


# ReAct prompt template for tool use
REACT_PROMPT_TEMPLATE = """You are a helpful AI assistant with access to tools.

You have access to the following tools:

{tools}

Use the following format:

Question: the input question you must answer
Thought: you should always think about what to do
Action: the action to take, should be one of [{tool_names}]
Action Input: the input to the action
Observation: the result of the action
... (this Thought/Action/Action Input/Observation can repeat N times)
Thought: I now know the final answer
Final Answer: the final answer to the original input question

Begin!

Question: {input}
Thought: {agent_scratchpad}
"""


class CustomLLMWrapper(BaseLanguageModel):
    """
    Wrapper to make our model manager compatible with LangChain.

    LangChain expects a BaseLanguageModel interface, but we have
    a custom ModelManager. This adapter bridges the gap.
    """

    def __init__(self, model_manager):
        """
        Initialize wrapper.

        Args:
            model_manager: ModelManager instance
        """
        super().__init__()
        self.model_manager = model_manager

    @property
    def _llm_type(self) -> str:
        """Return LLM type identifier"""
        return "custom_vllm_or_unsloth"

    async def _agenerate(self, prompts: List[str], **kwargs) -> Any:
        """Generate responses asynchronously"""
        # For agent use, we typically get one prompt at a time
        if not prompts:
            raise ValueError("No prompts provided")

        prompt = prompts[0]

        # Convert to message format
        messages = [{"role": "user", "content": prompt}]

        # Generate
        text, _ = await self.model_manager.generate(
            messages=messages,
            max_tokens=kwargs.get("max_tokens", 1024),
            temperature=kwargs.get("temperature", 0.7),
            top_p=kwargs.get("top_p", 0.95),
        )

        return text

    def _generate(self, prompts: List[str], **kwargs) -> Any:
        """Synchronous generation (not used in async context)"""
        import asyncio
        loop = asyncio.get_event_loop()
        return loop.run_until_complete(self._agenerate(prompts, **kwargs))

    async def apredict(self, text: str, **kwargs) -> str:
        """Async predict - single text input/output"""
        result = await self._agenerate([text], **kwargs)
        return result

    def predict(self, text: str, **kwargs) -> str:
        """Sync predict"""
        import asyncio
        loop = asyncio.get_event_loop()
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
        tools: List[Tool],
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

        # Wrap model for LangChain compatibility
        self.llm = CustomLLMWrapper(model_manager)

        # Create agent
        self.agent = self._create_agent()

    def _create_agent(self) -> Optional[Any]:
        """Create agent with tools"""
        if not self.tools:
            logger.warning("No tools provided - agent will not be created")
            return None

        try:
            if USING_CLASSIC:
                # Legacy approach using langchain-classic
                logger.info("Using langchain-classic AgentExecutor")
                
                # Create prompt
                prompt = PromptTemplate(
                    template=REACT_PROMPT_TEMPLATE,
                    input_variables=["input", "agent_scratchpad"],
                    partial_variables={
                        "tools": self._format_tools(),
                        "tool_names": ", ".join([t.name for t in self.tools]),
                    }
                )

                # Create ReAct agent
                agent = create_react_agent(
                    llm=self.llm,
                    tools=self.tools,
                    prompt=prompt
                )

                executor = AgentExecutor(
                    agent=agent,
                    tools=self.tools,
                    verbose=self.verbose,
                    max_iterations=5,
                    handle_parsing_errors=True,
                )
            else:
                # Modern LangChain 1.0+ approach
                logger.info("Using modern LangChain create_agent")
                from langchain.agents import create_agent
                
                # Convert tools to the format expected by create_agent
                executor = create_agent(
                    model=self.llm,
                    tools=self.tools,
                    system_prompt="You are a helpful AI assistant. Use the available tools to answer questions.",
                )

            logger.info(f"✅ LangChain agent created with {len(self.tools)} tools")
            return executor

        except Exception as e:
            logger.error(f"Failed to create agent: {e}")
            logger.exception(e)
            return None

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
        if not use_tools or self.agent is None:
            # Direct generation without tools
            messages = [{"role": "user", "content": input_text}]
            output, tokens = await self.model_manager.generate(messages)

            return {
                "output": output,
                "tokens_used": tokens,
                "tool_calls": [],
                "used_tools": False
            }

        # Run agent with tools
        try:
            # Run in executor to avoid blocking
            import asyncio
            loop = asyncio.get_event_loop()

            def _run_agent():
                if USING_CLASSIC:
                    # Legacy API
                    return self.agent.invoke({"input": input_text})
                else:
                    # Modern API expects messages format
                    return self.agent.invoke({
                        "messages": [{"role": "user", "content": input_text}]
                    })

            result = await loop.run_in_executor(None, _run_agent)

            # Extract tool usage from intermediate steps if available
            tool_calls = []
            
            if USING_CLASSIC and "intermediate_steps" in result:
                for action, observation in result["intermediate_steps"]:
                    tool_calls.append({
                        "tool": action.tool,
                        "input": action.tool_input,
                        "output": observation
                    })
                output = result.get("output", "")
            else:
                # Modern API - extract from messages
                output = result.get("messages", [])[-1].get("content", "") if result.get("messages") else str(result)

            return {
                "output": output,
                "tokens_used": None,  # Not tracked in agent mode
                "tool_calls": tool_calls,
                "used_tools": len(tool_calls) > 0
            }

        except Exception as e:
            logger.error(f"Agent execution failed: {e}")
            logger.exception(e)
            # Fallback to direct generation
            messages = [{"role": "user", "content": input_text}]
            output, tokens = await self.model_manager.generate(messages)

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
        # Convert messages to single input text
        # For proper agent integration, we'd need to maintain conversation history
        # For now, we combine into a single prompt
        input_text = self._format_messages_as_prompt(messages)

        return await self.run(input_text, use_tools=use_tools)

    def _format_messages_as_prompt(self, messages: List[Dict[str, str]]) -> str:
        """Format messages as prompt for agent"""
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

        # Get the last user message as the main query
        user_messages = [m for m in messages if m.get("role") == "user"]
        if user_messages:
            return user_messages[-1].get("content", "")

        return "\n".join(parts)


def create_agent_with_tools(
    model_manager,
    enable_search: bool = True,
    enable_python_repl: bool = False,
    verbose: bool = False
) -> LangChainAgent:
    """
    Factory function to create agent with tools.

    Args:
        model_manager: ModelManager instance
        enable_search: Whether to enable search tool
        enable_python_repl: Whether to enable Python REPL
        verbose: Whether to log agent steps

    Returns:
        Configured LangChain agent
    """
    from tools.search_tool import create_search_tool_from_env
    from tools.python_repl import create_python_repl_from_env

    tools = []

    # Add search tool
    if enable_search:
        try:
            search_tool = create_search_tool_from_env()
            if search_tool:
                tools.append(search_tool)
                logger.info("✅ Search tool enabled")
        except Exception as e:
            logger.warning(f"Failed to initialize search tool: {e}")

    # Add Python REPL tool
    if enable_python_repl:
        try:
            python_tool = create_python_repl_from_env()
            if python_tool:
                tools.append(python_tool)
                logger.info("✅ Python REPL tool enabled")
        except Exception as e:
            logger.warning(f"Failed to initialize Python REPL tool: {e}")

    return LangChainAgent(
        model_manager=model_manager,
        tools=tools,
        verbose=verbose
    )