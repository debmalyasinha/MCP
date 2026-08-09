"""An educational MCP server exposing tools, a resource, and a prompt."""

from pydantic import BaseModel, Field

from mcp.server import MCPServer


class Note(BaseModel):
    """A study note returned as structured MCP output."""

    id: int = Field(description="Unique note identifier")
    topic: str = Field(description="Subject being studied")
    text: str = Field(description="The note content")


notes: list[Note] = [
    Note(
        id=1,
        topic="MCP",
        text="A client discovers and invokes capabilities exposed by a server.",
    )
]

mcp = MCPServer(
    "MCP Study Notes",
    instructions="Use this server to store short study notes and learn MCP primitives.",
)


@mcp.tool()
def add_note(topic: str, text: str) -> Note:
    """Add a study note and return the newly created note."""
    note = Note(id=max((note.id for note in notes), default=0) + 1, topic=topic, text=text)
    notes.append(note)
    return note


@mcp.tool()
def list_notes(topic: str | None = None) -> list[Note]:
    """List all study notes, optionally filtered by topic (case-insensitive)."""
    if topic is None:
        return notes.copy()
    return [note for note in notes if note.topic.casefold() == topic.casefold()]


@mcp.resource("guide://mcp-basics")
def mcp_basics() -> str:
    """Return a compact guide to the three main MCP server capabilities."""
    return (
        "MCP basics\n"
        "- Tools are model-invoked actions or computations.\n"
        "- Resources are application-controlled context identified by URIs.\n"
        "- Prompts are user-selected message templates.\n"
        "- A transport, such as stdio or Streamable HTTP, carries protocol messages."
    )


@mcp.prompt()
def study_topic(topic: str, level: str = "beginner") -> str:
    """Create a prompt that asks an assistant to teach a topic."""
    return (
        f"Teach me {topic} at the {level} level. Explain the core idea, give one "
        "small example, and finish with three review questions."
    )


def main() -> None:
    """Run the MCP server over standard input/output."""
    mcp.run()


if __name__ == "__main__":
    main()
