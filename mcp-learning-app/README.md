# MCP Learning App

A deliberately small Python project that demonstrates an MCP server and client without an LLM or API key.

The server exposes all three core capability types:

- **Tools**: `add_note` and `list_notes`
- **Resource**: `guide://mcp-basics`
- **Prompt**: `study_topic`

The client launches the server over **stdio**, negotiates the MCP protocol version, discovers its capabilities, and invokes each one. The code uses the current v2 Python SDK API.

## 1. Set up

Python 3.11 or newer is required.

Using `venv` and `pip`:

```powershell
cd C:\Work\mcp-learning-app
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
```

If `python` is not found immediately after installation, open a new terminal or invoke the installed executable by its full path.

Or using `uv`:

```powershell
cd C:\Work\mcp-learning-app
uv sync --extra dev
```

## 2. Run the demo client

```powershell
.\.venv\Scripts\mcp-study-client.exe
```

The client starts the server itself, displays the discovered capabilities, and then opens an action menu.

These commands use the virtual environment directly, so PowerShell script execution does not need to be enabled. If you prefer activation, enable it only for the current shell with `Set-ExecutionPolicy -Scope Process Bypass`, then run `.\.venv\Scripts\Activate.ps1`.

## 3. Inspect the server interactively

The official MCP Inspector provides a UI for listing and invoking server capabilities:

```powershell
.\.venv\Scripts\mcp.exe dev src/mcp_learning_app/server.py
```

You can also run the stdio server directly with `.\.venv\Scripts\mcp-study-server.exe`. It will appear to wait silently because MCP messages are exchanged on stdin/stdout; use the client or Inspector to interact with it.

## 4. Run tests

```powershell
.\.venv\Scripts\python.exe -m pytest
```

See [TEST_SCENARIOS.md](TEST_SCENARIOS.md) for the complete automated and manual scenario matrix.

## How the pieces fit

1. `client.py` starts `server.py` as a child process and opens a stdio transport.
2. The unified `Client` negotiates the protocol version automatically.
3. `list_tools`, `list_resources`, and `list_prompts` perform capability discovery.
4. `call_tool`, `read_resource`, and `get_prompt` exercise those capabilities.
5. `MCPServer` derives JSON schemas from Python type hints and Pydantic models.

The notes are intentionally kept in memory, so they reset whenever the server process exits. A useful next exercise is replacing the `notes` list with SQLite while leaving the MCP-facing functions unchanged.

## Connect from another MCP host

After installing the project, use this stdio configuration in a compatible host:

```json
{
  "mcpServers": {
    "study-notes": {
      "command": "C:\\Work\\mcp-learning-app\\.venv\\Scripts\\python.exe",
      "args": ["-m", "mcp_learning_app.server"]
    }
  }
}
```

Use the exact Python path from the virtual environment where this project is installed.

## Project layout

```text
mcp-learning-app/
|-- pyproject.toml
|-- src/mcp_learning_app/
|   |-- server.py   # MCP capabilities and stdio entry point
|   `-- client.py   # MCP discovery and invocation example
`-- tests/
    `-- test_server.py
```

References: [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) and [MCP documentation](https://modelcontextprotocol.io/).
