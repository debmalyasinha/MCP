"""A minimal MCP client that explores the study-notes server."""

import asyncio
import json
import sys

from mcp import Client, StdioServerParameters, stdio_client, types


def read_input(prompt: str) -> str | None:
    """Read trimmed terminal input, returning None when input is closed."""
    try:
        return input(prompt).strip()
    except (EOFError, KeyboardInterrupt):
        return None


async def run() -> None:
    """Start the server and provide an interactive MCP client."""
    server = StdioServerParameters(
        command=sys.executable,
        args=["-m", "mcp_learning_app.server"],
    )

    transport = stdio_client(server)
    async with Client(transport) as client:
        server_name = client.server_info.name if client.server_info else "anonymous server"
        print(f"Connected to: {server_name}")
        print(f"Protocol version: {client.protocol_version}")

        tools = await client.list_tools()
        resources = await client.list_resources()
        prompts = await client.list_prompts()
        print(f"Tools: {', '.join(tool.name for tool in tools.tools)}")
        print(f"Resources: {', '.join(str(item.uri) for item in resources.resources)}")
        print(f"Prompts: {', '.join(prompt.name for prompt in prompts.prompts)}")

        while True:
            print(
                "\nChoose an action:\n"
                "1. Add a note\n"
                "2. List notes\n"
                "3. Read the MCP guide\n"
                "4. Create a study prompt\n"
                "0. Exit"
            )
            choice = read_input("Selection: ")

            if choice in (None, "0"):
                print("Goodbye.")
                return

            if choice == "1":
                topic = read_input("Topic: ")
                text = read_input("Note: ")
                if topic is None or text is None:
                    print("Goodbye.")
                    return
                if not topic or not text:
                    print("Topic and note are required.")
                    continue
                result = await client.call_tool("add_note", {"topic": topic, "text": text})
                print(json.dumps(result.structured_content, indent=2))
                continue

            if choice == "2":
                topic = read_input("Topic filter (leave blank for all): ")
                if topic is None:
                    print("Goodbye.")
                    return
                arguments = {"topic": topic} if topic else {}
                result = await client.call_tool("list_notes", arguments)
                print(json.dumps(result.structured_content, indent=2))
                continue

            if choice == "3":
                guide = await client.read_resource("guide://mcp-basics")
                guide_text = next(
                    (item.text for item in guide.contents if isinstance(item, types.TextResourceContents)),
                    "",
                )
                print(f"\n{guide_text}")
                continue

            if choice == "4":
                topic = read_input("Study topic: ")
                level = read_input("Level [beginner]: ")
                if topic is None or level is None:
                    print("Goodbye.")
                    return
                level = level or "beginner"
                if not topic:
                    print("Study topic is required.")
                    continue
                prompt = await client.get_prompt(
                    "study_topic",
                    arguments={"topic": topic, "level": level},
                )
                prompt_text = next(
                    (
                        message.content.text
                        for message in prompt.messages
                        if isinstance(message.content, types.TextContent)
                    ),
                    "",
                )
                print(f"\n{prompt_text}")
                continue

            print("Unknown selection. Enter a number from 0 to 4.")


def main() -> None:
    """Run the asynchronous client."""
    try:
        asyncio.run(run())
    except (EOFError, KeyboardInterrupt):
        print("\nGoodbye.")


if __name__ == "__main__":
    main()
