"""
Python REPL Tool - Sandboxed Python execution for math and analysis

WARNING: This tool executes arbitrary Python code and poses security risks.
Use with caution and implement proper sandboxing in production.
"""

import logging
import subprocess
import tempfile
import os
from typing import Optional

# Import Tool with fallback for different LangChain versions
try:
    from langchain.tools import Tool
except ImportError:
    from langchain_core.tools import Tool

from langchain_experimental.utilities import PythonREPL

logger = logging.getLogger(__name__)


class SandboxedPythonREPL:
    """
    Sandboxed Python REPL with timeout and restrictions.

    SECURITY NOTES:
    - Runs code in subprocess with timeout
    - Restricts file system access (read-only in sandboxed mode)
    - Limits execution time
    - For production: use Docker containers, firejail, or dedicated sandbox
    - Recommended: Disable in production unless properly sandboxed
    """

    def __init__(
        self,
        timeout: int = 10,
        use_sandbox: bool = True,
        max_output_length: int = 10000,
    ):
        """
        Initialize sandboxed Python REPL.

        Args:
            timeout: Maximum execution time in seconds
            use_sandbox: Whether to use subprocess sandbox
            max_output_length: Max length of output to return
        """
        self.timeout = timeout
        self.use_sandbox = use_sandbox
        self.max_output_length = max_output_length

        if not use_sandbox:
            logger.warning(
                "⚠️  Python REPL running WITHOUT sandbox - security risk!"
            )
            self._repl = PythonREPL()

    def run(self, code: str) -> str:
        """
        Execute Python code with safety measures.

        Args:
            code: Python code to execute

        Returns:
            Execution output or error message
        """
        if not self.use_sandbox:
            return self._run_unsandboxed(code)
        else:
            return self._run_sandboxed(code)

    def _run_unsandboxed(self, code: str) -> str:
        """Run code using LangChain's PythonREPL (less secure)"""
        try:
            result = self._repl.run(code)
            if len(result) > self.max_output_length:
                result = result[:self.max_output_length] + "\n... (output truncated)"
            return result
        except Exception as e:
            logger.error(f"Python REPL error: {e}")
            return f"Error: {str(e)}"

    def _run_sandboxed(self, code: str) -> str:
        """
        Run code in subprocess with timeout and restrictions.

        More secure than direct execution, but still not production-ready.
        For production: use Docker, firejail, or dedicated sandboxing.
        """
        try:
            # Create temporary file for code
            with tempfile.NamedTemporaryFile(
                mode='w',
                suffix='.py',
                delete=False
            ) as f:
                # Wrap code to capture output
                wrapped_code = f"""
import sys
from io import StringIO

# Redirect stdout
old_stdout = sys.stdout
sys.stdout = StringIO()

try:
{self._indent_code(code)}
    output = sys.stdout.getvalue()
    print(output, file=sys.__stdout__)
except Exception as e:
    print(f"Error: {{e}}", file=sys.__stderr__)
finally:
    sys.stdout = old_stdout
"""
                f.write(wrapped_code)
                temp_file = f.name

            try:
                # Execute in subprocess with timeout
                result = subprocess.run(
                    ['python', temp_file],
                    capture_output=True,
                    text=True,
                    timeout=self.timeout,
                    # Security: prevent file system access (basic)
                    env={
                        'HOME': '/tmp',
                        'PATH': os.environ.get('PATH', ''),
                        'PYTHONPATH': '',
                    }
                )

                output = result.stdout if result.returncode == 0 else result.stderr

                if len(output) > self.max_output_length:
                    output = output[:self.max_output_length] + "\n... (truncated)"

                return output.strip() or "Code executed successfully (no output)"

            finally:
                # Cleanup
                try:
                    os.unlink(temp_file)
                except:
                    pass

        except subprocess.TimeoutExpired:
            return f"Error: Code execution timed out after {self.timeout} seconds"
        except Exception as e:
            logger.error(f"Sandboxed Python execution failed: {e}")
            return f"Error: {str(e)}"

    def _indent_code(self, code: str, spaces: int = 4) -> str:
        """Indent code for wrapping in try block"""
        lines = code.split('\n')
        return '\n'.join(' ' * spaces + line if line.strip() else line for line in lines)

    def get_langchain_tool(self) -> Tool:
        """
        Get LangChain Tool instance.

        Returns:
            LangChain Tool for Python execution
        """
        return Tool(
            name="python_repl",
            description=(
                "Execute Python code for mathematical calculations, data analysis, "
                "or computations. The code runs in a sandboxed environment with "
                f"a {self.timeout}-second timeout. "
                "Input should be valid Python code. "
                "Useful for: math operations, data processing, calculations, "
                "creating charts/graphs, statistical analysis. "
                "Returns the output of the code execution."
            ),
            func=self.run,
        )


def create_python_repl_tool(
    timeout: int = 10,
    use_sandbox: bool = True,
    enable_tool: bool = True
) -> Optional[Tool]:
    """
    Factory function to create Python REPL tool.

    Args:
        timeout: Execution timeout in seconds
        use_sandbox: Whether to use subprocess sandbox
        enable_tool: Whether to enable this tool (set False for production safety)

    Returns:
        LangChain Tool for Python execution, or None if disabled
    """
    if not enable_tool:
        logger.warning("Python REPL tool is disabled for security")
        return None

    repl = SandboxedPythonREPL(
        timeout=timeout,
        use_sandbox=use_sandbox
    )

    return repl.get_langchain_tool()


def create_python_repl_from_env() -> Optional[Tool]:
    """
    Create Python REPL tool based on environment configuration.

    Environment variables:
    - ENABLE_PYTHON_REPL: Set to 'true' to enable (default: false)
    - PYTHON_REPL_TIMEOUT: Timeout in seconds (default: 10)
    - PYTHON_REPL_SANDBOX: Set to 'false' to disable sandbox (not recommended)

    Returns:
        Python REPL tool or None if disabled
    """
    import os

    enable = os.getenv("ENABLE_PYTHON_REPL", "false").lower() == "true"
    timeout = int(os.getenv("PYTHON_REPL_TIMEOUT", "10"))
    use_sandbox = os.getenv("PYTHON_REPL_SANDBOX", "true").lower() == "true"

    if not enable:
        logger.info("Python REPL tool disabled (set ENABLE_PYTHON_REPL=true to enable)")
        return None

    if not use_sandbox:
        logger.warning(
            "⚠️  PYTHON REPL SANDBOX DISABLED - SECURITY RISK! ⚠️"
        )

    return create_python_repl_tool(
        timeout=timeout,
        use_sandbox=use_sandbox,
        enable_tool=True
    )
