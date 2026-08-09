# Test Scenarios

The suite is organized in three layers. Run every automated scenario with:

```powershell
.\.venv\Scripts\python.exe -m pytest
```

## Server unit scenarios

| Scenario | Expected result |
| --- | --- |
| Add a note to the seeded store | The note receives ID 2 and is stored |
| Add after a non-contiguous high ID | The new ID is one greater than the maximum |
| Add to an empty store | The first ID is 1 |
| List all notes | All notes are returned in a separate list |
| Filter using different letter casing | Matching topics are returned case-insensitively |
| Filter with an unknown topic | An empty list is returned |
| Read the learning guide | Tools, resources, prompts, and transports are described |
| Render a prompt without a level | The beginner default is used |
| Render a prompt with a level | The supplied level is used |

## MCP contract scenarios

| Scenario | Expected result |
| --- | --- |
| Discover capabilities | Two tools, one resource, and one prompt are advertised |
| Inspect the `add_note` schema | `topic` and `text` are required |
| Call `add_note` through MCP | A successful structured `Note` result is returned |
| Call filtered `list_notes` through MCP | A wrapped structured list is returned |
| Read `guide://mcp-basics` | Text resource content is returned |
| Get `study_topic` | A text prompt message is returned |

## Interactive client scenarios

| Scenario | Expected result |
| --- | --- |
| Complete menu workflow | Add, filter, prompt, resource, and exit all succeed |
| Unknown menu selection | An error is shown and the menu remains usable |
| Empty note fields | Validation is shown without calling the tool |
| Empty prompt topic | Validation is shown without requesting the prompt |
| End of terminal input | The client closes cleanly |

## Manual Inspector scenario

With Node.js and `npx` installed, run:

```powershell
.\.venv\Scripts\mcp.exe dev src\mcp_learning_app\server.py
```

Use the Inspector to list every capability, call both tools, read the resource, and render the prompt. Confirm the displayed schemas and results match the automated contract tests.

