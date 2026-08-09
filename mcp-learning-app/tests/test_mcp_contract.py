import asyncio

from mcp import Client, types

from mcp_learning_app import server


def test_mcp_capabilities_and_results() -> None:
    async def exercise_server() -> None:
        server.notes[:] = [server.Note(id=1, topic="MCP", text="Seed note")]

        async with Client(server.mcp) as client:
            tools = await client.list_tools()
            resources = await client.list_resources()
            prompts = await client.list_prompts()

            assert {tool.name for tool in tools.tools} == {"add_note", "list_notes"}
            assert [str(resource.uri) for resource in resources.resources] == ["guide://mcp-basics"]
            assert [prompt.name for prompt in prompts.prompts] == ["study_topic"]

            add_tool = next(tool for tool in tools.tools if tool.name == "add_note")
            assert set(add_tool.input_schema["required"]) == {"topic", "text"}

            added = await client.call_tool(
                "add_note",
                {"topic": "Python", "text": "Schemas come from type hints."},
            )
            assert added.is_error is False
            assert added.structured_content == {
                "id": 2,
                "topic": "Python",
                "text": "Schemas come from type hints.",
            }

            listed = await client.call_tool("list_notes", {"topic": "python"})
            assert listed.structured_content == {
                "result": [
                    {
                        "id": 2,
                        "topic": "Python",
                        "text": "Schemas come from type hints.",
                    }
                ]
            }

            guide = await client.read_resource("guide://mcp-basics")
            assert isinstance(guide.contents[0], types.TextResourceContents)
            assert "MCP basics" in guide.contents[0].text

            prompt = await client.get_prompt("study_topic", {"topic": "tools"})
            assert isinstance(prompt.messages[0].content, types.TextContent)
            assert "Teach me tools at the beginner level" in prompt.messages[0].content.text

    asyncio.run(exercise_server())
