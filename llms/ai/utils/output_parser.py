"""
Output Parser for LLM Responses - Robust Version

Extracts the final answer from LLM responses, filtering out:
- Thinking/reasoning sections (analysis, thinking, etc.)
- Tool call markers (assistantcommentary to=X json{...})
- Chain of thought traces
- Internal markers and formatting

Designed to ALWAYS return clean, user-facing content regardless of LLM output format.
"""

import re
import logging
from typing import Optional, Tuple, List

logger = logging.getLogger(__name__)


class OutputParser:
    """
    Robust parser to extract clean final answers from LLM responses.

    Guarantees clean output by:
    1. First trying to extract explicit final answer markers
    2. Removing all known internal markers
    3. Extracting meaningful content from what remains
    4. Final sanitization to catch any edge cases
    """

    # =========================================================================
    # INTERNAL MARKERS TO REMOVE (tool calls, analysis, etc.)
    # =========================================================================
    INTERNAL_MARKER_PATTERNS = [
        # Tool call patterns - comprehensive matching
        (r'assistantcommentary\s+to=\w+\s*(?:json|code)?\s*\{[^}]*\}', re.IGNORECASE),
        (r'commentary\s+to=\w+\s*(?:json|code)?\s*\{[^}]*\}', re.IGNORECASE),
        (r'assistantcommentary\s+to=\w+[^\n]*', re.IGNORECASE),
        (r'commentary\s+to=\w+[^\n]*', re.IGNORECASE),

        # Analysis/thinking markers (plain text, not XML)
        (r'^analysis\s*', re.IGNORECASE | re.MULTILINE),
        (r'\banalysis\s*$', re.IGNORECASE | re.MULTILINE),

        # Assistant channel markers from Harmony format
        (r'assistant(?:analysis|commentary|final|thinking)\s*', re.IGNORECASE),

        # JSON-like tool call remnants
        (r'\{["\']query["\']\s*:\s*["\'][^"\']*["\']\s*\}', 0),

        # Repeated content markers (LLM sometimes duplicates)
        (r'(.{50,}?)\1+', 0),  # Remove exact duplicates
    ]

    # =========================================================================
    # THINKING PATTERNS TO REMOVE (XML-style tags)
    # =========================================================================
    THINKING_PATTERNS = [
        # DeepSeek/Claude thinking tags
        (r'<think>.*?</think>', re.DOTALL | re.IGNORECASE),
        (r'<thinking>.*?</thinking>', re.DOTALL | re.IGNORECASE),

        # Reasoning/analysis tags
        (r'<reasoning>.*?</reasoning>', re.DOTALL | re.IGNORECASE),
        (r'<reason>.*?</reason>', re.DOTALL | re.IGNORECASE),
        (r'<analysis>.*?</analysis>', re.DOTALL | re.IGNORECASE),
        (r'<analyze>.*?</analyze>', re.DOTALL | re.IGNORECASE),

        # Internal/scratchpad tags
        (r'<internal>.*?</internal>', re.DOTALL | re.IGNORECASE),
        (r'<scratchpad>.*?</scratchpad>', re.DOTALL | re.IGNORECASE),
        (r'<scratch>.*?</scratch>', re.DOTALL | re.IGNORECASE),

        # Chain of thought
        (r'<cot>.*?</cot>', re.DOTALL | re.IGNORECASE),
        (r'<chain_of_thought>.*?</chain_of_thought>', re.DOTALL | re.IGNORECASE),

        # Planning
        (r'<plan>.*?</plan>', re.DOTALL | re.IGNORECASE),
        (r'<planning>.*?</planning>', re.DOTALL | re.IGNORECASE),
        (r'<step>.*?</step>', re.DOTALL | re.IGNORECASE),
        (r'<steps>.*?</steps>', re.DOTALL | re.IGNORECASE),
    ]

    # =========================================================================
    # FINAL ANSWER EXTRACTION PATTERNS (priority order)
    # =========================================================================
    FINAL_ANSWER_PATTERNS = [
        # Harmony format - assistantfinal marker (most common)
        (r'assistantfinal\s*(.*)', re.DOTALL | re.IGNORECASE),

        # Standard final answer markers
        (r'<final[_\s]?answer>(.*?)</final[_\s]?answer>', re.DOTALL | re.IGNORECASE),
        (r'<answer>(.*?)</answer>', re.DOTALL | re.IGNORECASE),
        (r'<response>(.*?)</response>', re.DOTALL | re.IGNORECASE),
        (r'<output>(.*?)</output>', re.DOTALL | re.IGNORECASE),

        # ReAct format
        (r'Final Answer:\s*(.*?)(?:\n\n|$)', re.DOTALL | re.IGNORECASE),
        (r'Answer:\s*(.*?)(?:\n\n|$)', re.DOTALL | re.IGNORECASE),
    ]

    # =========================================================================
    # ReAct pattern markers
    # =========================================================================
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

        This is the MAIN entry point. Guarantees clean output.

        Args:
            raw_response: Raw LLM output that may contain thinking/reasoning
            preserve_markdown: Whether to preserve markdown formatting

        Returns:
            Clean final answer suitable for user display
        """
        if not raw_response:
            return ""

        original_length = len(raw_response)
        response = raw_response

        # =====================================================================
        # STEP 1: Try to extract explicit final answer (most reliable)
        # =====================================================================
        final_answer = cls._extract_final_answer(response)
        if final_answer and len(final_answer) > 20:
            logger.info(f"📝 Extracted final answer: {original_length} -> {len(final_answer)} chars")
            return cls._sanitize_output(final_answer, preserve_markdown)

        # =====================================================================
        # STEP 2: Remove all internal markers
        # =====================================================================
        response = cls._remove_internal_markers(response)

        # =====================================================================
        # STEP 3: Remove XML-style thinking sections
        # =====================================================================
        response = cls._remove_thinking_sections(response)

        # =====================================================================
        # STEP 4: Handle ReAct format if detected
        # =====================================================================
        if cls._is_react_format(response):
            response = cls._extract_from_react(response)

        # =====================================================================
        # STEP 5: If still looks like incomplete analysis, try to extract content
        # =====================================================================
        if cls._looks_like_internal_content(response):
            extracted = cls._extract_meaningful_content(response)
            if extracted and len(extracted) > 50:
                response = extracted

        # =====================================================================
        # STEP 6: Final sanitization
        # =====================================================================
        response = cls._sanitize_output(response, preserve_markdown)

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
                if content and len(content) > 10:
                    return content
        return None

    @classmethod
    def _remove_internal_markers(cls, response: str) -> str:
        """Remove all internal markers (tool calls, analysis, etc.)"""
        result = response
        for pattern, flags in cls.INTERNAL_MARKER_PATTERNS:
            try:
                result = re.sub(pattern, '', result, flags=flags)
            except Exception as e:
                logger.warning(f"Pattern error: {e}")
        return result.strip()

    @classmethod
    def _remove_thinking_sections(cls, response: str) -> str:
        """Remove all XML-style thinking/reasoning sections"""
        result = response
        for pattern, flags in cls.THINKING_PATTERNS:
            result = re.sub(pattern, '', result, flags=flags)
        return result.strip()

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
    def _looks_like_internal_content(cls, response: str) -> bool:
        """Check if response still contains internal LLM markers"""
        internal_indicators = [
            'analysis',
            'commentary',
            'the user asks',
            'they want',
            'let me',
            'i should',
            'i need to',
            'first, ',
            'then, ',
            'wait,',
            'actually,',
            'maybe',
            'perhaps',
            'not sure',
        ]
        lower_response = response.lower()

        # Check if starts with internal content
        for indicator in internal_indicators:
            if lower_response.startswith(indicator):
                return True

        return False

    @classmethod
    def _extract_meaningful_content(cls, response: str) -> Optional[str]:
        """
        Extract meaningful content from an incomplete/messy response.

        Used when the LLM didn't properly format its output but there's
        useful information buried in the response.
        """
        if not response:
            return None

        # Try to find answer-like patterns
        answer_patterns = [
            (r'(?:The\s+)?answer\s+is[:\s]+(.+)', re.DOTALL | re.IGNORECASE),
            (r'In\s+summary[,:\s]+(.+)', re.DOTALL | re.IGNORECASE),
            (r'To\s+summarize[,:\s]+(.+)', re.DOTALL | re.IGNORECASE),
            (r'(?:So|Therefore|Thus)[,:\s]+(.{50,})', re.DOTALL | re.IGNORECASE),
            (r'(?:ANSI|IEEE|IEC|NEMA|ISO)[/-]?\S+\s+(?:is|defines?|covers?|refers? to)[^.]+\.', re.IGNORECASE),
        ]

        for pattern_tuple in answer_patterns:
            pattern = pattern_tuple[0] if isinstance(pattern_tuple, tuple) else pattern_tuple
            flags = pattern_tuple[1] if isinstance(pattern_tuple, tuple) and len(pattern_tuple) > 1 else 0
            match = re.search(pattern, response, flags)
            if match:
                extracted = match.group(1).strip() if match.lastindex else match.group(0).strip()
                if len(extracted) > 50:
                    return extracted

        # Find informative sentences (not questions, not meta-commentary)
        sentences = re.split(r'(?<=[.!])\s+', response)
        informative = []

        skip_patterns = [
            r'^(?:Maybe|Perhaps|Could be|Not sure|I think|I\'m not)',
            r'^(?:The user|They) (?:ask|want|said)',
            r'^(?:But|Wait|Actually)\b',
            r'^(?:Let me|I should|I\'ll|I need)',
            r'^\?',
            r'^(?:analysis|commentary)',
        ]

        for sent in sentences:
            sent = sent.strip()
            if len(sent) < 30 or sent.endswith('?'):
                continue
            if any(re.match(p, sent, re.IGNORECASE) for p in skip_patterns):
                continue
            informative.append(sent)

        if informative:
            result = ' '.join(informative)
            if len(result) > 100:
                return result

        # Last resort: return cleaned content if substantial
        cleaned = re.sub(r'^(?:analysis|thinking|commentary)\s*', '', response, flags=re.IGNORECASE)
        if len(cleaned) > 200:
            return cleaned

        return None

    @classmethod
    def _sanitize_output(cls, response: str, preserve_markdown: bool = True) -> str:
        """
        Final sanitization step.

        Ensures the output is clean for user display by removing any
        remaining internal markers or artifacts.
        """
        if not response:
            return ""

        # Remove any remaining internal markers
        internal_patterns = [
            r'analysis\s*$',
            r'^analysis\s*',
            r'assistantfinal\s*',
            r'assistantcommentary[^\n]*',
            r'commentary\s+to=\w+[^\n]*',
            r'\{["\']query["\']:[^\}]+\}',
        ]

        for pattern in internal_patterns:
            response = re.sub(pattern, '', response, flags=re.IGNORECASE)

        # Remove empty XML-like tags
        response = re.sub(r'<[^>]+>\s*</[^>]+>', '', response)

        # Remove orphaned opening/closing tags
        response = re.sub(
            r'</?(?:think|thinking|reasoning|analysis|internal|cot|plan|step|answer|final_answer)>',
            '', response, flags=re.IGNORECASE
        )

        # Clean up multiple newlines
        response = re.sub(r'\n{3,}', '\n\n', response)

        # Clean up leading/trailing whitespace
        response = response.strip()

        # Remove common prefix artifacts
        prefixes_to_remove = ['assistant', 'Assistant:', 'AI:', 'Response:', 'Output:']
        for prefix in prefixes_to_remove:
            if response.lower().startswith(prefix.lower()):
                response = response[len(prefix):].lstrip(':').strip()

        # Remove trailing incomplete sentences (often truncation artifacts)
        if not response.rstrip().endswith(('.', '!', '?', '```', '"', "'")):
            # Find last complete sentence
            last_period = max(
                response.rfind('. '),
                response.rfind('.\n'),
                response.rfind('! '),
                response.rfind('!\n'),
                response.rfind('? '),
                response.rfind('?\n'),
            )
            if last_period > len(response) * 0.7:  # Only trim if we keep most of it
                response = response[:last_period + 1].strip()

        return response


class StreamingOutputParser:
    """
    Stateful parser for streaming responses.

    Filters out thinking sections in real-time as chunks arrive.
    Handles both XML-style tags and plain text markers (analysis...assistantfinal).
    """

    def __init__(self):
        self.thinking_depth = 0
        self.accumulated_text = ""
        self.found_final_marker = False
        self.in_analysis_section = False
        self.buffer = ""  # Buffer for incomplete markers

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
        self.buffer += chunk

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
                self.buffer = ""  # Clear buffer

                if after_marker:
                    return self._clean_chunk(after_marker), False
                return "", False

            # If text contains analysis markers, we're in thinking section
            if 'analysis' in lower_accumulated[:100]:
                self.in_analysis_section = True

            # Check for tool call markers - don't show these
            if 'assistantcommentary' in lower_accumulated or 'commentary to=' in lower_accumulated:
                self.buffer = ""
                return "", True

        # If we've found the final marker, pass through content (cleaned)
        if self.found_final_marker:
            self.buffer = ""
            return self._clean_chunk(chunk), False

        # Handle XML-style thinking tags
        open_matches = self.think_open_pattern.findall(chunk)
        close_matches = self.think_close_pattern.findall(chunk)

        self.thinking_depth += len(open_matches)
        self.thinking_depth -= len(close_matches)
        self.thinking_depth = max(0, self.thinking_depth)

        # If inside thinking/analysis section, don't return content
        if self.thinking_depth > 0 or self.in_analysis_section:
            return "", True

        # Clean and return
        self.buffer = ""
        return self._clean_chunk(chunk), False

    def _clean_chunk(self, chunk: str) -> str:
        """Clean a chunk for display"""
        # Remove XML tags
        chunk = self.think_open_pattern.sub('', chunk)
        chunk = self.think_close_pattern.sub('', chunk)

        # Remove internal markers
        chunk = re.sub(r'assistantfinal\s*', '', chunk, flags=re.IGNORECASE)
        chunk = re.sub(r'assistantcommentary[^\n]*', '', chunk, flags=re.IGNORECASE)
        chunk = re.sub(r'analysis\s*', '', chunk, flags=re.IGNORECASE)

        return chunk

    def reset(self):
        """Reset parser state for new response"""
        self.thinking_depth = 0
        self.accumulated_text = ""
        self.found_final_marker = False
        self.in_analysis_section = False
        self.buffer = ""

    def get_final_output(self) -> str:
        """
        Get the final parsed output after streaming completes.

        This applies the full OutputParser to ensure clean output.
        """
        return OutputParser.parse(self.accumulated_text)


def parse_llm_output(raw_response: str) -> str:
    """
    Convenience function to parse LLM output.

    This is the main function to call for non-streaming responses.

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


def sanitize_for_user(text: str) -> str:
    """
    Final sanitization before showing to user.

    Use this as a last-resort cleanup for any text going to the user.
    """
    return OutputParser._sanitize_output(text)
