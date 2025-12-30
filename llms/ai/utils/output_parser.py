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
- Plain text markers (analysisXXX...assistantfinalYYY)
- ReAct format (Thought/Action/Observation)
"""

import re
import logging
from typing import Optional, Tuple, List

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

    # Patterns for extracting final answer (checked FIRST - order matters!)
    FINAL_ANSWER_PATTERNS = [
        # Plain text "assistantfinal" marker (most common for this model)
        # Matches: "analysisXXX...assistantfinal## Answer" -> captures "## Answer"
        (r'assistantfinal(.*)', re.DOTALL | re.IGNORECASE),

        # Plain text "final" marker after "analysis" section
        (r'analysis.*?final(.*)', re.DOTALL | re.IGNORECASE),

        # Explicit final answer tags
        (r'<final[_\s]?answer>(.*?)</final[_\s]?answer>', re.DOTALL | re.IGNORECASE),
        (r'<answer>(.*?)</answer>', re.DOTALL | re.IGNORECASE),
        (r'<response>(.*?)</response>', re.DOTALL | re.IGNORECASE),
        (r'<output>(.*?)</output>', re.DOTALL | re.IGNORECASE),

        # Final markers (for ReAct and similar patterns)
        (r'Final Answer:\s*(.*?)(?:\n\n|$)', re.DOTALL | re.IGNORECASE),
        (r'Answer:\s*(.*?)(?:\n\n|$)', re.DOTALL | re.IGNORECASE),
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

        original_length = len(raw_response)
        response = raw_response

        # Step 1: Check for plain text "analysis...assistantfinal" format (most common)
        if 'assistantfinal' in response.lower():
            # Extract everything after "assistantfinal"
            match = re.search(r'assistantfinal(.*)', response, re.DOTALL | re.IGNORECASE)
            if match:
                final_content = match.group(1).strip()
                if final_content:
                    logger.info(f"📝 Extracted after 'assistantfinal': {original_length} -> {len(final_content)} chars")
                    return cls._clean_response(final_content, preserve_markdown)

        # Step 2: Check for "analysis...final" format without "assistant" prefix
        if response.lower().startswith('analysis') and 'final' in response.lower():
            match = re.search(r'final(.*)', response, re.DOTALL | re.IGNORECASE)
            if match:
                final_content = match.group(1).strip()
                if final_content:
                    logger.info(f"📝 Extracted after 'final': {original_length} -> {len(final_content)} chars")
                    return cls._clean_response(final_content, preserve_markdown)

        # Step 2b: Handle incomplete responses that start with "analysis" but never reach "assistantfinal"
        # This happens when LLM runs out of tokens before completing its thinking
        if response.lower().startswith('analysis') and 'assistantfinal' not in response.lower():
            # Try to extract the most useful content from the analysis
            extracted = cls._extract_from_incomplete_analysis(response)
            if extracted:
                logger.info(f"📝 Extracted from incomplete analysis: {original_length} -> {len(extracted)} chars")
                return cls._clean_response(extracted, preserve_markdown)

        # Step 3: Try to extract explicit final answer markers
        final_answer = cls._extract_final_answer(response)
        if final_answer:
            logger.info(f"📝 Extracted explicit final answer: {original_length} -> {len(final_answer)} chars")
            return cls._clean_response(final_answer, preserve_markdown)

        # Step 4: Remove thinking/reasoning sections (XML tags)
        response = cls._remove_thinking_sections(response)

        # Step 5: Handle ReAct format if detected
        if cls._is_react_format(response):
            response = cls._extract_from_react(response)

        # Step 6: Clean up the response
        response = cls._clean_response(response, preserve_markdown)

        if len(response) != original_length:
            logger.info(f"📝 Output parsed: {original_length} -> {len(response)} chars")

        return response

    @classmethod
    def _extract_final_answer(cls, response: str) -> Optional[str]:
        """Extract content from explicit final answer markers"""
        for pattern, flags in cls.FINAL_ANSWER_PATTERNS:
            match = re.search(pattern, response, flags)
            if match:
                content = match.group(1).strip()
                if content:
                    return content
        return None

    @classmethod
    def _extract_from_incomplete_analysis(cls, response: str) -> Optional[str]:
        """
        Extract useful content from an incomplete analysis response.

        This handles cases where the LLM started with 'analysis' but ran out
        of tokens before reaching 'assistantfinal'.
        """
        # Remove the "analysis" prefix
        content = response
        if content.lower().startswith('analysis'):
            content = content[8:].strip()  # len('analysis') = 8

        if not content:
            return None

        # Look for answer-like patterns in the content
        answer_patterns = [
            # Explicit answer markers
            (r'(?:The\s+)?answer\s+is[:\s]+(.+)', re.DOTALL | re.IGNORECASE),
            (r'In\s+summary[,:\s]+(.+)', re.DOTALL | re.IGNORECASE),
            (r'To\s+summarize[,:\s]+(.+)', re.DOTALL | re.IGNORECASE),
            (r'(?:So|Therefore|Thus)[,:\s]+(.{50,})', re.DOTALL | re.IGNORECASE),

            # ANSI/IEEE device number patterns (specific to electrical standards)
            (r'(ANSI\s+(?:device\s+)?(?:code|number)?\s*25[^.]*\.)', re.IGNORECASE),
            (r'(Device\s+(?:number|code)\s+25[^.]*\.)', re.IGNORECASE),
            (r'((?:ANSI|IEEE)\s+(?:C37\.2|C37\.90)[^.]*\.)', re.IGNORECASE),
        ]

        for pattern, flags in answer_patterns:
            match = re.search(pattern, content, flags)
            if match:
                extracted = match.group(1).strip()
                if len(extracted) > 50:  # Must be substantial
                    return extracted

        # Look for the last substantial paragraph (often contains conclusions)
        paragraphs = [p.strip() for p in content.split('\n\n') if p.strip()]
        if paragraphs:
            # Filter out very short paragraphs
            substantial = [p for p in paragraphs if len(p) > 100]
            if substantial:
                # Return the last substantial paragraph (often the conclusion)
                return substantial[-1]

            # If no substantial paragraphs, return all content after removing first line
            # (which is often just "The user asks..." context)
            lines = content.split('\n')
            if len(lines) > 2:
                remaining = '\n'.join(lines[1:]).strip()
                if len(remaining) > 100:
                    return remaining

        # Fallback: return the content as-is if it's long enough
        if len(content) > 200:
            return content

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
        ]
        for prefix in prefixes_to_remove:
            if response.lower().startswith(prefix.lower()):
                response = response[len(prefix):].lstrip(':').strip()

        return response


class StreamingOutputParser:
    """
    Stateful parser for streaming responses.

    Handles both XML-style tags (<think>...</think>) and
    plain text markers (analysis...assistantfinal).
    """

    def __init__(self):
        self.thinking_depth = 0
        self.accumulated_text = ""
        self.found_final_marker = False
        self.in_analysis_section = False

        # XML-style patterns
        self.think_open_pattern = re.compile(r'<think(?:ing)?>', re.IGNORECASE)
        self.think_close_pattern = re.compile(r'</think(?:ing)?>', re.IGNORECASE)

    def process_chunk(self, chunk: str) -> Tuple[str, bool]:
        """
        Process a streaming chunk.

        Args:
            chunk: New chunk received from LLM

        Returns:
            Tuple of (clean_chunk_to_display, is_in_thinking_section)
        """
        if not chunk:
            return "", self.thinking_depth > 0 or self.in_analysis_section

        # Accumulate text
        self.accumulated_text += chunk

        # Check if we've found "assistantfinal" in the accumulated text
        if not self.found_final_marker:
            lower_accumulated = self.accumulated_text.lower()

            # Check for "assistantfinal" marker
            if 'assistantfinal' in lower_accumulated:
                self.found_final_marker = True
                self.in_analysis_section = False

                # Find position of marker and return content after it
                idx = lower_accumulated.find('assistantfinal')
                after_marker = self.accumulated_text[idx + len('assistantfinal'):]

                # Only return the new part from this chunk
                if after_marker:
                    return after_marker, False
                return "", False

            # If text starts with "analysis" and no final marker yet, we're in analysis
            if lower_accumulated.startswith('analysis') or 'analysis' in lower_accumulated[:50]:
                self.in_analysis_section = True
                return "", True  # Don't show analysis section

        # If we've found the final marker, pass through content
        if self.found_final_marker:
            # Clean any stray XML tags
            clean_chunk = self.think_open_pattern.sub('', chunk)
            clean_chunk = self.think_close_pattern.sub('', clean_chunk)
            return clean_chunk, False

        # Handle XML-style thinking tags
        open_matches = self.think_open_pattern.findall(chunk)
        close_matches = self.think_close_pattern.findall(chunk)

        self.thinking_depth += len(open_matches)
        self.thinking_depth -= len(close_matches)
        self.thinking_depth = max(0, self.thinking_depth)

        # If inside thinking section, don't return content
        if self.thinking_depth > 0 or self.in_analysis_section:
            return "", True

        # Clean any stray tags from chunk
        clean_chunk = self.think_open_pattern.sub('', chunk)
        clean_chunk = self.think_close_pattern.sub('', clean_chunk)

        return clean_chunk, False

    def reset(self):
        """Reset parser state for new response"""
        self.thinking_depth = 0
        self.accumulated_text = ""
        self.found_final_marker = False
        self.in_analysis_section = False


def parse_llm_output(raw_response: str) -> str:
    """
    Convenience function to parse LLM output.

    Args:
        raw_response: Raw LLM response text

    Returns:
        Clean final answer
    """
    return OutputParser.parse(raw_response)


def create_streaming_parser() -> StreamingOutputParser:
    """
    Create a new streaming output parser.

    Returns:
        StreamingOutputParser instance
    """
    return StreamingOutputParser()
