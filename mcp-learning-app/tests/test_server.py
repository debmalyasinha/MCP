import pytest

from mcp_learning_app import server


@pytest.fixture(autouse=True)
def reset_notes() -> None:
    server.notes[:] = [server.Note(id=1, topic="MCP", text="Seed note")]


def test_add_note_assigns_the_next_id() -> None:
    note = server.add_note("Python", "Type hints define tool schemas.")

    assert note == server.Note(id=2, topic="Python", text="Type hints define tool schemas.")
    assert server.notes[-1] == note


def test_add_note_uses_highest_existing_id() -> None:
    server.notes.append(server.Note(id=8, topic="Testing", text="Existing note"))

    note = server.add_note("Python", "New note")

    assert note.id == 9


def test_add_note_starts_at_one_when_store_is_empty() -> None:
    server.notes.clear()

    note = server.add_note("MCP", "First note")

    assert note.id == 1


def test_list_notes_returns_all_notes_in_a_new_list() -> None:
    server.add_note("Python", "A Python note")

    results = server.list_notes()
    results.clear()

    assert len(server.notes) == 2


def test_list_notes_filters_without_case_sensitivity() -> None:
    server.add_note("Python", "A Python note")
    server.add_note("MCP", "Another MCP note")

    results = server.list_notes("mcp")

    assert [note.topic for note in results] == ["MCP", "MCP"]


def test_list_notes_returns_empty_list_when_topic_does_not_match() -> None:
    assert server.list_notes("unknown") == []


def test_resource_describes_each_core_capability() -> None:
    guide = server.mcp_basics()

    assert "Tools are model-invoked" in guide
    assert "Resources are application-controlled" in guide
    assert "Prompts are user-selected" in guide
    assert "transport" in guide


def test_study_prompt_uses_beginner_default() -> None:
    result = server.study_topic("resources")

    assert "resources" in result
    assert "beginner" in result
    assert "three review questions" in result


def test_study_prompt_uses_custom_level() -> None:
    result = server.study_topic("resources", "intermediate")

    assert "resources" in result
    assert "intermediate" in result

