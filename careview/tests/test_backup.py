import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import backup_careview  # noqa: E402
from backup_careview import create_backup, prepare_restore, verify_backup  # noqa: E402
from careview_store import CareviewStore  # noqa: E402


def create_careview_database(
    path: Path,
    *,
    object_key: str | None = None,
    evidence: bytes | None = None,
) -> None:
    store = CareviewStore(path)
    _, token, _ = store.setup(
        "Backup Test Workspace",
        "Backup Administrator",
        "backup-admin@example.test",
        "BackupStrong!Passphrase42",
    )
    if object_key is None:
        return
    if evidence is None:
        raise ValueError("Evidence bytes are required with an object key.")
    context = store.authenticate(token)
    patient = store.create_patient(context, "Backup Test Patient", "Test Room")
    store.create_scene(
        context,
        patient["id"],
        {
            "zone": "kitchen",
            "mediaType": "image",
            "durationSeconds": None,
            "framesSubmitted": 1,
        },
        {"status": "completed", "summary": "Test", "findings": []},
        [
            {
                "id": "e" * 32,
                "objectKey": object_key,
                "mimeType": "image/jpeg",
                "byteSize": len(evidence),
                "sha256": hashlib.sha256(evidence).hexdigest(),
                "width": 800,
                "height": 600,
                "frameNumber": 1,
                "timestampMs": None,
            }
        ],
    )


def write_manifest(backup: Path, relative_files: list[str]) -> None:
    files = []
    for relative in relative_files:
        item = backup / relative
        files.append(
            {
                "path": relative,
                "bytes": item.stat().st_size,
                "sha256": hashlib.sha256(item.read_bytes()).hexdigest(),
            }
        )
    (backup / "manifest.json").write_text(
        json.dumps(
            {
                "format": 1,
                "databaseSchemaVersion": 0,
                "createdAt": "2026-01-01T00:00:00Z",
                "files": files,
            }
        ),
        encoding="utf-8",
    )


class BackupTests(unittest.TestCase):
    def test_backup_contains_integrity_checked_database_media_and_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / "data"
            backups = root / "backups"
            media = data / "media" / "aa"
            media.mkdir(parents=True)
            evidence_bytes = b"private-evidence"
            object_key = "a" * 64
            evidence = media / object_key
            evidence.write_bytes(evidence_bytes)
            create_careview_database(
                data / "careview.db",
                object_key=object_key,
                evidence=evidence_bytes,
            )
            result = create_backup(data, backups)

            stored = result / "media" / "aa" / object_key
            self.assertEqual(stored.read_bytes(), b"private-evidence")
            with closing(sqlite3.connect(result / "careview.db")) as database:
                self.assertEqual(
                    database.execute("SELECT name FROM workspaces").fetchone()[0],
                    "Backup Test Workspace",
                )
            manifest = json.loads((result / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["format"], 1)
            self.assertEqual(manifest["databaseSchemaVersion"], 0)
            self.assertEqual({item["path"] for item in manifest["files"]}, {"careview.db", f"media/aa/{'a' * 64}"})
            self.assertTrue(all(len(item["sha256"]) == 64 for item in manifest["files"]))
            verify_backup(result)

    def test_backup_rejects_nested_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary) / "data"
            data.mkdir()
            create_careview_database(data / "careview.db")
            with self.assertRaisesRegex(ValueError, "separate and not nested"):
                create_backup(data, data / "backups")

    def test_verify_detects_media_corruption(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / "data"
            media = data / "media" / "bb"
            media.mkdir(parents=True)
            object_key = "b" * 64
            evidence = media / object_key
            evidence.write_bytes(b"valid")
            create_careview_database(
                data / "careview.db", object_key=object_key, evidence=b"valid"
            )
            backup = create_backup(data, root / "backups")
            (backup / "media" / "bb" / object_key).write_bytes(b"bad")
            with self.assertRaisesRegex(ValueError, "checksum failed"):
                verify_backup(backup)

    def test_prepare_restore_revokes_sessions_and_copies_verified_media(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / "data"
            media = data / "media" / "cc"
            media.mkdir(parents=True)
            object_key = "c" * 64
            evidence = media / object_key
            evidence.write_bytes(b"evidence")
            create_careview_database(
                data / "careview.db", object_key=object_key, evidence=b"evidence"
            )
            with closing(sqlite3.connect(data / "careview.db")) as database:
                database.execute("PRAGMA journal_mode=WAL")
            backup = create_backup(data, root / "backups")
            staged = prepare_restore(backup, root / "restore-stage")
            with closing(sqlite3.connect(staged / "careview.db")) as database:
                self.assertEqual(database.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)
                self.assertEqual(database.execute("PRAGMA journal_mode").fetchone()[0], "delete")
            self.assertFalse((staged / "careview.db-wal").exists())
            self.assertFalse((staged / "careview.db-shm").exists())
            self.assertEqual((staged / "media" / "cc" / object_key).read_bytes(), b"evidence")

    def test_verify_requires_manifested_database_and_never_creates_one(self):
        with tempfile.TemporaryDirectory() as temporary:
            backup = Path(temporary) / "backup"
            backup.mkdir()
            write_manifest(backup, [])

            with self.assertRaisesRegex(ValueError, "must contain careview.db"):
                verify_backup(backup)
            self.assertFalse((backup / "careview.db").exists())

    def test_verify_rejects_non_careview_schema_and_unknown_schema_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_backup = root / "fake-backup"
            fake_backup.mkdir()
            with closing(sqlite3.connect(fake_backup / "careview.db")) as database:
                database.execute("CREATE TABLE unrelated (value TEXT)")
            write_manifest(fake_backup, ["careview.db"])
            with self.assertRaisesRegex(ValueError, "supported Careview database schema"):
                verify_backup(fake_backup)

            data = root / "data"
            data.mkdir()
            create_careview_database(data / "careview.db")
            with closing(sqlite3.connect(data / "careview.db")) as database:
                database.execute("PRAGMA user_version = 99")
            with self.assertRaisesRegex(ValueError, "schema version"):
                create_backup(data, root / "backups")

    def test_prepare_restore_reverifies_staged_copy_against_trusted_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = root / "data"
            media = data / "media" / "dd"
            media.mkdir(parents=True)
            object_key = "d" * 64
            evidence = media / object_key
            evidence.write_bytes(b"verified-evidence")
            create_careview_database(
                data / "careview.db",
                object_key=object_key,
                evidence=b"verified-evidence",
            )
            backup = create_backup(data, root / "backups")
            original_copy = backup_careview._copy_file_exclusive

            def mutate_source_during_copy(source, destination):
                if source.name == object_key:
                    source.write_bytes(b"changed-after-verification")
                original_copy(source, destination)

            staging = root / "restore-stage"
            with patch.object(
                backup_careview,
                "_copy_file_exclusive",
                side_effect=mutate_source_during_copy,
            ):
                with self.assertRaisesRegex(ValueError, "checksum failed"):
                    prepare_restore(backup, staging)
            self.assertFalse(staging.exists())


if __name__ == "__main__":
    unittest.main()
