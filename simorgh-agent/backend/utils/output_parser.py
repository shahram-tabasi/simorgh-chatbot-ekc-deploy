"""
Output Parser for LLM Responses

Extracts the final answer from LLM responses, filtering out:
- Thinking/reasoning sections
- Internal analysis
- Chain of thought markers
- Tool call traces

Supports various LLM output formats including:
- DeepSeek-style thinking tags (<think>...</think>)
- Claude-style thinking tags (<thinking>...</thinking>)
- Custom markers (analysis, reasoning, etc.)
- ReAct format (Thought/Action/Observation)
"""

import re
import logging
from typing import Optional, Tuple

logger = logging.getLogger(__name__)


class OutputParser:
    """
    Parser to extract clean final answers from LLM responses.

    Removes thinking/reasoning sections and returns only the user-facing content.
    """

    # Patterns for thinking/reasoning sections to remove
    THINKING_PATTERNS = [
        # DeepSeek thinking tags
        (r'<think>.*?</think>', re.DOTALL | re.IGNORECASE),
        (r'<thinking>.*?</thinking>', re.DOTALL | re.IGNORECASE),

        # Reasoning tags
        (r'<reasoning>.*?</reasoning>', re.DOTALL | re.IGNORECASE),
        (r'<reason>.*?</reason>', re.DOTALL | re.IGNORECASE),

        # Analysis tags
        (r'<analysis>.*?</analysis>', re.DOTALL | re.IGNORECASE),
        (r'<analyze>.*?</analyze>', re.DOTALL | re.IGNORECASE),

        # Internal tags
        (r'<internal>.*?</internal>', re.DOTALL | re.IGNORECASE),
        (r'<scratchpad>.*?</scratchpad>', re.DOTALL | re.IGNORECASE),
        (r'<scratch>.*?</scratch>', re.DOTALL | re.IGNORECASE),

        # Chain of thought tags
        (r'<cot>.*?</cot>', re.DOTALL | re.IGNORECASE),
        (r'<chain_of_thought>.*?</chain_of_thought>', re.DOTALL | re.IGNORECASE),

        # Planning tags
        (r'<plan>.*?</plan>', re.DOTALL | re.IGNORECASE),
        (r'<planning>.*?</planning>', re.DOTALL | re.IGNORECASE),

        # Step-by-step thinking
        (r'<step>.*?</step>', re.DOTALL | re.IGNORECASE),
        (r'<steps>.*?</steps>', re.DOTALL | re.IGNORECASE),
    ]

    # Patterns for extracting final answer
    FINAL_ANSWER_PATTERNS = [
        # Explicit final answer tags
        (r'<final[_\s]?answer>(.*?)</final[_\s]?answer>', re.DOTALL | re.IGNORECASE),
        (r'<answer>(.*?)</answer>', re.DOTALL | re.IGNORECASE),
        (r'<response>(.*?)</response>', re.DOTALL | re.IGNORECASE),
        (r'<output>(.*?)</output>', re.DOTALL | re.IGNORECASE),

        # Final markers (for ReAct and similar patterns)
        (r'Final Answer:\s*(.*?)(?:\n\n|$)', re.DOTALL | re.IGNORECASE),
        (r'Answer:\s*(.*?)(?:\n\n|$)', re.DOTALL | re.IGNORECASE),

        # Assistant final marker
        (r'assistantfinal\s*(.*)', re.DOTALL | re.IGNORECASE),
    ]

    # ReAct pattern markers to remove
    REACT_PATTERNS = [
        (r'Thought:\s*.*?(?=Action:|Observation:|Final Answer:|$)', re.DOTALL | re.IGNORECASE),
        (r'Action:\s*.*?(?=Action Input:|Observation:|$)', re.DOTALL | re.IGNORECASE),
        (r'Action Input:\s*.*?(?=Observation:|$)', re.DOTALL | re.IGNORECASE),
        (r'Observation:\s*.*?(?=Thought:|Final Answer:|$)', re.DOTALL | re.IGNORECASE),
    ]

    @classmethod
    def parse(cls, raw_response: str, preserve_markdown: bool = True) -> str:
        """
        Parse LLM response and extract clean final answer.

        Args:
            raw_response: Raw LLM output that may contain thinking/reasoning
            preserve_markdown: Whether to preserve markdown formatting

        Returns:
            Clean final answer suitable for user display
        """
        if not raw_response:
            return raw_response

        response = raw_response

        # Step 1: Try to extract explicit final answer first
        final_answer = cls._extract_final_answer(response)
        if final_answer:
            logger.debug(f"Extracted explicit final answer ({len(final_answer)} chars)")
            return cls._clean_response(final_answer, preserve_markdown)

        # Step 2: Remove thinking/reasoning sections
        response = cls._remove_thinking_sections(response)

        # Step 3: Handle ReAct format if detected
        if cls._is_react_format(response):
            response = cls._extract_from_react(response)

        # Step 4: Clean up the response
        response = cls._clean_response(response, preserve_markdown)

        logger.debug(f"Parsed response: {len(raw_response)} -> {len(response)} chars")
        return response

    @classmethod
    def _extract_final_answer(cls, response: str) -> Optional[str]:
        """Extract content from explicit final answer markers"""
        for pattern, flags in cls.FINAL_ANSWER_PATTERNS:
            match = re.search(pattern, response, flags)
            if match:
                return match.group(1).strip()
        return None

    @classmethod
    def _remove_thinking_sections(cls, response: str) -> str:
        """Remove all thinking/reasoning sections"""
        result = response
        for pattern, flags in cls.THINKING_PATTERNS:
            result = re.sub(pattern, '', result, flags=flags)
        return result

    @classmethod
    def _is_react_format(cls, response: str) -> bool:
        """Check if response is in ReAct format"""
        react_markers = ['Thought:', 'Action:', 'Action Input:', 'Observation:', 'Final Answer:']
        return any(marker in response for marker in react_markers)

    @classmethod
    def _extract_from_react(cls, response: str) -> str:
        """Extract final answer from ReAct format"""
        # Look for Final Answer first
        final_match = re.search(r'Final Answer:\s*(.*?)(?:\n\n|$)', response, re.DOTALL | re.IGNORECASE)
        if final_match:
            return final_match.group(1).strip()

        # Remove intermediate steps and return what's left
        result = response
        for pattern, flags in cls.REACT_PATTERNS:
            result = re.sub(pattern, '', result, flags=flags)

        return result.strip()

    @classmethod
    def _clean_response(cls, response: str, preserve_markdown: bool = True) -> str:
        """Clean up the final response"""
        if not response:
            return response

        # Remove empty XML-like tags
        response = re.sub(r'<[^>]+>\s*</[^>]+>', '', response)

        # Remove orphaned opening/closing tags
        response = re.sub(r'</?(?:think|thinking|reasoning|analysis|internal|cot|plan|step)>', '', response, flags=re.IGNORECASE)

        # Clean up multiple newlines
        response = re.sub(r'\n{3,}', '\n\n', response)

        # Clean up leading/trailing whitespace
        response = response.strip()

        # Remove common prefix artifacts
        prefixes_to_remove = [
            'assistant', 'Assistant:', 'AI:', 'Response:',
            'assistantanalysis', 'assistantfinal'
        ]
        for prefix in prefixes_to_remove:
            if response.lower().startswith(prefix.lower()):
                response = response[len(prefix):].lstrip(':').strip()

        return response

    @classmethod
    def parse_streaming(cls, chunk: str, accumulated: str = "") -> Tuple[str, bool]:
        """
        Parse a streaming chunk for real-time display.

        Args:
            chunk: New chunk received from LLM
            accumulated: Previously accumulated chunks

        Returns:
            Tuple of (display_text, is_in_thinking_section)
        """
        full_text = accumulated + chunk

        # Check if we're inside a thinking section
        # Count opening and closing tags
        think_opens = len(re.findall(r'<think(?:ing)?>', full_text, re.IGNORECASE))
        think_closes = len(re.findall(r'</think(?:ing)?>', full_text, re.IGNORECASE))

        is_thinking = think_opens > think_closes

        if is_thinking:
            # We're inside thinking - don't display this chunk
            return "", True

        # Check if chunk contains complete thinking section
        if re.search(r'<think(?:ing)?>', chunk, re.IGNORECASE):
            # Remove thinking sections from chunk
            cleaned = cls._remove_thinking_sections(chunk)
            return cleaned, False

        return chunk, False


def parse_llm_output(raw_response: str) -> str:
    """
    Convenience function to parse LLM output.

    Args:
        raw_response: Raw LLM response text

    Returns:
        Clean final answer
    """
    return OutputParser.parse(raw_response)


def parse_streaming_chunk(chunk: str, accumulated: str = "") -> Tuple[str, bool]:
    """
    Convenience function for streaming parsing.

    Args:
        chunk: New chunk from LLM
        accumulated: Previously accumulated text

    Returns:
        Tuple of (display_text, is_in_thinking)
    """
    return OutputParser.parse_streaming(chunk, accumulated)
