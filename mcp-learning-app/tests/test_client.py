import subprocess
import sys


def run_client(user_input: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "mcp_learning_app.client"],
        input=user_input,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def test_interactive_client_complete_workflow() -> None:
    result = run_client(
        "1\nPython\nType hints define schemas.\n"
        "2\nPython\n"
        "4\nMCP transports\nintermediate\n"
        "3\n"
        "0\n"
    )

    assert result.returncode == 0, result.stderr
    assert "Connected to: MCP Study Notes" in result.stdout
    assert "Tools: add_note, list_notes" in result.stdout
    assert '"topic": "Python"' in result.stdout
    assert "Teach me MCP transports at the intermediate level" in result.stdout
    assert "Tools are model-invoked actions" in result.stdout
    assert "Goodbye." in result.stdout


def test_interactive_client_rejects_invalid_input_and_recovers() -> None:
    result = run_client(
        "9\n"
        "1\n\nA note without a topic\n"
        "4\n\nbeginner\n"
        "0\n"
    )

    assert result.returncode == 0, result.stderr
    assert "Unknown selection. Enter a number from 0 to 4." in result.stdout
    assert "Topic and note are required." in result.stdout
    assert "Study topic is required." in result.stdout
    assert "Goodbye." in result.stdout


def test_interactive_client_handles_end_of_input() -> None:
    result = run_client("")

    assert result.returncode == 0, result.stderr
    assert "Connected to: MCP Study Notes" in result.stdout
    assert "Goodbye." in result.stdout
