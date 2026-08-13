"""Create a consistent Careview database and evidence-media backup.

The SQLite snapshot is taken first. Evidence files are immutable and are written
before their database rows, so copying media second cannot leave the snapshot
with a reference to a missing file. A concurrent upload can only add an
unreferenced file to the backup, which is safe to ignore during restore.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import time
from contextlib import closing
from pathlib import Path


OBJECT_KEY_LENGTH = 64
BACKUP_FORMAT_VERSION = 1
# Careview's current SQLite schema predates numbered migrations. Treat its
# explicit user_version of zero plus the exact table signatures below as schema
# version zero, and fail closed when either changes.
DATABASE_SCHEMA_VERSION = 0
REQUIRED_SCHEMA = {
    "workspaces": (
        ("id", "TEXT", 0, 1),
        ("name", "TEXT", 1, 0),
        ("created_at", "TEXT", 1, 0),
    ),
    "users": (
        ("id", "TEXT", 0, 1),
        ("workspace_id", "TEXT", 1, 0),
        ("display_name", "TEXT", 1, 0),
        ("email", "TEXT", 1, 0),
        ("password_salt", "BLOB", 1, 0),
        ("password_hash", "BLOB", 1, 0),
        ("role", "TEXT", 1, 0),
        ("active", "INTEGER", 1, 0),
        ("created_at", "TEXT", 1, 0),
    ),
    "sessions": (
        ("token_hash", "TEXT", 0, 1),
        ("user_id", "TEXT", 1, 0),
        ("csrf_hash", "TEXT", 1, 0),
        ("created_at", "TEXT", 1, 0),
        ("expires_at", "INTEGER", 1, 0),
    ),
    "patients": (
        ("id", "TEXT", 0, 1),
        ("workspace_id", "TEXT", 1, 0),
        ("display_name", "TEXT", 1, 0),
        ("care_location", "TEXT", 1, 0),
        ("created_at", "TEXT", 1, 0),
        ("updated_at", "TEXT", 1, 0),
    ),
    "scenes": (
        ("id", "TEXT", 0, 1),
        ("workspace_id", "TEXT", 1, 0),
        ("patient_id", "TEXT", 1, 0),
        ("created_by", "TEXT", 1, 0),
        ("zone", "TEXT", 1, 0),
        ("media_type", "TEXT", 1, 0),
        ("duration_seconds", "REAL", 0, 0),
        ("frames_submitted", "INTEGER", 1, 0),
        ("assessment_json", "TEXT", 1, 0),
        ("created_at", "TEXT", 1, 0),
    ),
    "scene_media": (
        ("id", "TEXT", 0, 1),
        ("workspace_id", "TEXT", 1, 0),
        ("patient_id", "TEXT", 1, 0),
        ("scene_id", "TEXT", 1, 0),
        ("object_key", "TEXT", 1, 0),
        ("mime_type", "TEXT", 1, 0),
        ("byte_size", "INTEGER", 1, 0),
        ("sha256", "TEXT", 1, 0),
        ("width", "INTEGER", 0, 0),
        ("height", "INTEGER", 0, 0),
        ("frame_number", "INTEGER", 1, 0),
        ("timestamp_ms", "INTEGER", 0, 0),
        ("created_by", "TEXT", 1, 0),
        ("created_at", "TEXT", 1, 0),
    ),
    "findings": (
        ("id", "TEXT", 0, 1),
        ("workspace_id", "TEXT", 1, 0),
        ("patient_id", "TEXT", 1, 0),
        ("scene_id", "TEXT", 1, 0),
        ("finding_json", "TEXT", 1, 0),
        ("status", "TEXT", 1, 0),
        ("note", "TEXT", 1, 0),
        ("version", "INTEGER", 1, 0),
        ("reviewed_by", "TEXT", 0, 0),
        ("created_at", "TEXT", 1, 0),
        ("updated_at", "TEXT", 1, 0),
    ),
    "audit_events": (
        ("id", "TEXT", 0, 1),
        ("workspace_id", "TEXT", 0, 0),
        ("actor_user_id", "TEXT", 0, 0),
        ("patient_id", "TEXT", 0, 0),
        ("action", "TEXT", 1, 0),
        ("outcome", "TEXT", 1, 0),
        ("created_at", "TEXT", 1, 0),
    ),
}


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _is_link_or_junction(path: Path) -> bool:
    junction_check = getattr(path, "is_junction", None)
    return path.is_symlink() or bool(junction_check and junction_check())


def _reject_path_chain(path: Path) -> None:
    current = Path(os.path.abspath(path))
    while True:
        if current.exists() and _is_link_or_junction(current):
            raise ValueError(f"Links and junctions are not allowed in the storage path: {current}")
        parent = current.parent
        if parent == current:
            return
        current = parent


def _reject_links(root: Path) -> None:
    _reject_path_chain(root)
    if not root.exists():
        return
    for item in root.rglob("*"):
        if _is_link_or_junction(item):
            raise ValueError(f"Links and junctions are not allowed in the data tree: {item}")


def _copy_file_exclusive(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as input_file, destination.open("xb") as output_file:
        for block in iter(lambda: input_file.read(1024 * 1024), b""):
            output_file.write(block)


def _media_path(root: Path, object_key: str) -> Path:
    if (
        len(object_key) != OBJECT_KEY_LENGTH
        or object_key.casefold() != object_key
        or any(character not in "0123456789abcdef" for character in object_key)
    ):
        raise ValueError("The database contains an invalid evidence object key.")
    return root / object_key[:2] / object_key


def _open_database(
    path: Path, mode: str, *, immutable: bool = False
) -> sqlite3.Connection:
    if mode not in {"ro", "rw"}:
        raise ValueError("Unsupported SQLite open mode.")
    # URI mode=ro/rw fails if the file is absent. Verification must never turn
    # a missing careview.db into a newly-created empty SQLite database.
    uri = f"{path.resolve().as_uri()}?mode={mode}"
    if mode == "ro" and immutable:
        uri += "&immutable=1"
    return sqlite3.connect(uri, uri=True, timeout=30)


def _validate_schema(database: sqlite3.Connection) -> None:
    version = database.execute("PRAGMA user_version").fetchone()
    if version is None or version[0] != DATABASE_SCHEMA_VERSION:
        raise ValueError("The backup uses an unsupported Careview database schema version.")
    tables = {
        row[0]
        for row in database.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    if tables != set(REQUIRED_SCHEMA):
        raise ValueError("The backup is not a supported Careview database schema.")
    executable_schema_objects = database.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('trigger', 'view') LIMIT 1"
    ).fetchone()
    if executable_schema_objects is not None:
        raise ValueError("The backup contains unsupported executable schema objects.")
    for table, expected in REQUIRED_SCHEMA.items():
        actual = tuple(
            (row[1], row[2].upper(), row[3], row[5])
            for row in database.execute(f'PRAGMA table_info("{table}")').fetchall()
        )
        if actual != expected:
            raise ValueError("The backup is not a supported Careview database schema.")


def _check_database(database: sqlite3.Connection) -> list[sqlite3.Row]:
    integrity = database.execute("PRAGMA integrity_check").fetchone()
    if integrity is None or integrity[0] != "ok":
        raise RuntimeError("The SQLite backup failed its integrity check.")
    foreign_keys = database.execute("PRAGMA foreign_key_check").fetchall()
    if foreign_keys:
        raise RuntimeError("The SQLite backup failed its foreign-key check.")
    _validate_schema(database)
    database.row_factory = sqlite3.Row
    return database.execute(
        "SELECT object_key, byte_size, sha256 FROM scene_media ORDER BY object_key"
    ).fetchall()


def _load_manifest(backup: Path) -> dict:
    manifest_path = backup / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("The backup manifest is missing or invalid.") from exc
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"format", "databaseSchemaVersion", "createdAt", "files"}
        or manifest.get("format") != BACKUP_FORMAT_VERSION
        or manifest.get("databaseSchemaVersion") != DATABASE_SCHEMA_VERSION
        or not isinstance(manifest.get("createdAt"), str)
        or not isinstance(manifest.get("files"), list)
    ):
        raise ValueError("The backup manifest format is unsupported.")
    return manifest


def verify_backup(backup: Path) -> dict:
    _reject_links(backup)
    backup = backup.resolve()
    _reject_links(backup)
    manifest = _load_manifest(backup)
    listed: dict[str, dict] = {}
    for entry in manifest["files"]:
        if not isinstance(entry, dict) or set(entry) != {"path", "bytes", "sha256"}:
            raise ValueError("The backup manifest contains an invalid file entry.")
        relative = entry["path"]
        if not isinstance(relative, str) or not relative or "\\" in relative:
            raise ValueError("The backup manifest contains an unsafe path.")
        relative_path = Path(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts or relative_path.as_posix() != relative:
            raise ValueError("The backup manifest contains an unsafe path.")
        if relative in listed:
            raise ValueError("The backup manifest contains a duplicate path.")
        if (
            not isinstance(entry["bytes"], int)
            or isinstance(entry["bytes"], bool)
            or entry["bytes"] < 0
            or not isinstance(entry["sha256"], str)
            or len(entry["sha256"]) != 64
            or any(character not in "0123456789abcdef" for character in entry["sha256"])
        ):
            raise ValueError("The backup manifest contains invalid file metadata.")
        listed[relative] = entry

    if "careview.db" not in listed:
        raise ValueError("The backup manifest must contain careview.db.")

    actual = {
        item.relative_to(backup).as_posix()
        for item in backup.rglob("*")
        if item.is_file() and item != backup / "manifest.json"
    }
    if actual != set(listed):
        raise ValueError("The backup file set does not match its manifest.")
    for relative, entry in listed.items():
        item = backup / Path(relative)
        if item.stat().st_size != entry["bytes"] or _sha256(item) != entry["sha256"]:
            raise ValueError(f"Backup checksum failed: {relative}")

    database_path = backup / "careview.db"
    if not database_path.is_file() or database_path.is_symlink():
        raise ValueError("The backup must contain a regular careview.db file.")
    with closing(_open_database(database_path, "ro", immutable=True)) as database:
        media_rows = _check_database(database)
    expected_media = set()
    for row in media_rows:
        relative = _media_path(Path("media"), row["object_key"])
        expected_media.add(relative.as_posix())
        item = backup / relative
        if not item.is_file() or item.stat().st_size != row["byte_size"] or _sha256(item) != row["sha256"]:
            raise ValueError(f"Evidence verification failed: {row['object_key']}")
    if {path for path in actual if path.startswith("media/")} != expected_media:
        raise ValueError("The backup contains unreferenced or missing evidence files.")
    if actual != {"careview.db", *expected_media}:
        raise ValueError("The backup contains unsupported files.")
    return manifest


def prepare_restore(backup: Path, destination: Path) -> Path:
    """Verify a backup, copy its data into a new directory, and revoke sessions."""
    _reject_links(backup)
    _reject_path_chain(destination.parent)
    backup = backup.resolve()
    destination = destination.resolve()
    verified_manifest = verify_backup(backup)
    if destination.exists():
        raise FileExistsError(f"Restore staging directory already exists: {destination}")
    if _is_within(destination, backup) or _is_within(backup, destination):
        raise ValueError("The backup and restore staging directories must not be nested.")
    _reject_links(destination.parent)
    destination.mkdir()
    try:
        for relative in ["careview.db"]:
            _copy_file_exclusive(backup / relative, destination / relative)
        media_source = backup / "media"
        if media_source.is_dir():
            for source in sorted(path for path in media_source.rglob("*") if path.is_file()):
                _copy_file_exclusive(source, destination / source.relative_to(backup))
        # Use the already-verified manifest value, not another read from the
        # source tree. A source mutation during copying must fail verification
        # instead of replacing both the data and its expected hashes.
        (destination / "manifest.json").write_text(
            json.dumps(verified_manifest, indent=2) + "\n", encoding="utf-8"
        )
        verify_backup(destination)
        (destination / "manifest.json").unlink()
        staged_database = destination / "careview.db"
        with closing(_open_database(staged_database, "rw")) as database:
            _check_database(database)
            with database:
                database.execute("DELETE FROM sessions")
            _check_database(database)
            # Force any session-revocation WAL content back into careview.db.
            # The PowerShell restore swaps only this self-contained database
            # file, so no sidecar may be required for the deletion to survive.
            database.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            journal_mode = database.execute("PRAGMA journal_mode=DELETE").fetchone()
            if journal_mode is None or journal_mode[0].casefold() != "delete":
                raise RuntimeError("Could not make the restored database self-contained.")
            remaining_sessions = database.execute("SELECT COUNT(*) FROM sessions").fetchone()
            if remaining_sessions is None or remaining_sessions[0] != 0:
                raise RuntimeError("The restore staging database still contains sessions.")
        for suffix in ("-wal", "-shm", "-journal"):
            if (destination / f"careview.db{suffix}").exists():
                raise RuntimeError("Restore staging left an unsafe SQLite sidecar file.")
    except Exception:
        for item in sorted(destination.rglob("*"), reverse=True):
            if item.is_symlink() or item.is_file():
                item.unlink(missing_ok=True)
            elif item.is_dir():
                item.rmdir()
        destination.rmdir()
        raise
    return destination


def create_backup(data_root: Path, backup_root: Path) -> Path:
    _reject_links(data_root)
    _reject_links(backup_root)
    data_root = data_root.resolve()
    backup_root = backup_root.resolve()
    if data_root == backup_root or _is_within(backup_root, data_root) or _is_within(data_root, backup_root):
        raise ValueError("The data and backup directories must be separate and not nested.")

    database = data_root / "careview.db"
    media = data_root / "media"
    if not database.is_file() or database.is_symlink():
        raise FileNotFoundError(f"Careview database not found: {database}")
    _reject_links(media)

    backup_root.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    final = backup_root / f"careview-backup-{stamp}-{secrets.token_hex(3)}"
    temporary = backup_root / f".{final.name}.tmp-{secrets.token_hex(4)}"
    temporary.mkdir()

    try:
        backup_database = temporary / "careview.db"
        with closing(_open_database(database, "ro")) as source:
            with closing(sqlite3.connect(backup_database, timeout=30)) as destination:
                source.backup(destination)
                media_rows = _check_database(destination)

        for row in media_rows:
            source = _media_path(media, row["object_key"])
            if not source.is_file() or source.is_symlink():
                raise FileNotFoundError(f"Referenced evidence is missing: {row['object_key']}")
            if source.stat().st_size != row["byte_size"] or _sha256(source) != row["sha256"]:
                raise ValueError(f"Referenced evidence failed verification: {row['object_key']}")
            destination = _media_path(temporary / "media", row["object_key"])
            _copy_file_exclusive(source, destination)

        files = []
        for item in sorted(path for path in temporary.rglob("*") if path.is_file()):
            files.append(
                {
                    "path": item.relative_to(temporary).as_posix(),
                    "bytes": item.stat().st_size,
                    "sha256": _sha256(item),
                }
            )
        manifest = {
            "format": BACKUP_FORMAT_VERSION,
            "databaseSchemaVersion": DATABASE_SCHEMA_VERSION,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "files": files,
        }
        (temporary / "manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
        verify_backup(temporary)
        temporary.replace(final)
    except Exception:
        if temporary.exists():
            # Only delete the exact random staging tree we created under the
            # caller-selected backup root; never follow links or broad paths.
            for item in sorted(temporary.rglob("*"), reverse=True):
                if item.is_symlink() or item.is_file():
                    item.unlink(missing_ok=True)
                elif item.is_dir():
                    item.rmdir()
            temporary.rmdir()
        raise
    return final


def main() -> None:
    parser = argparse.ArgumentParser(description="Back up Careview's SQLite database and evidence media.")
    parser.add_argument("--data-root", type=Path, help="Directory containing careview.db and media/.")
    parser.add_argument("--backup-root", type=Path, help="Separate directory that will receive a timestamped backup.")
    parser.add_argument("--verify-backup", type=Path, help="Verify an existing Careview backup and exit.")
    parser.add_argument("--prepare-restore", type=Path, help="Verify a backup and copy restorable data from it.")
    parser.add_argument("--destination", type=Path, help="New staging directory for --prepare-restore.")
    args = parser.parse_args()
    try:
        if args.prepare_restore:
            if not args.destination or args.data_root or args.backup_root or args.verify_backup:
                parser.error("--prepare-restore requires --destination and cannot be combined with other modes.")
            result = prepare_restore(args.prepare_restore, args.destination)
            print(f"Careview restore staged with sessions revoked: {result}")
            return
        if args.verify_backup:
            if args.data_root or args.backup_root or args.destination:
                parser.error("--verify-backup cannot be combined with backup creation options.")
            verify_backup(args.verify_backup)
            print(f"Careview backup verified: {args.verify_backup.resolve()}")
            return
        if not args.data_root or not args.backup_root:
            parser.error("--data-root and --backup-root are required to create a backup.")
        result = create_backup(args.data_root, args.backup_root)
    except Exception as exc:
        print(f"Backup failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    print(f"Careview backup created: {result}")


if __name__ == "__main__":
    main()
