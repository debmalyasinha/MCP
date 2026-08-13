"""Authenticated, workspace-scoped persistence for the Careview prototype.

Only derived scene-review records and evidence metadata are stored here. Image
bytes remain in the private filesystem media store and are never written to
SQLite.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import time
import unicodedata
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class StoreValidationError(ValueError):
    """A supplied record failed validation."""


class AuthenticationError(RuntimeError):
    """A session is missing, expired, or invalid."""


class AuthorizationError(RuntimeError):
    """The authenticated user lacks the required role."""


class NotFoundError(RuntimeError):
    """A workspace-scoped record was not found."""


class ConflictError(RuntimeError):
    """A unique constraint or optimistic concurrency check failed."""

    def __init__(self, message: str, *, current: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.current = current


EMAIL_RE = re.compile(r"\A[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}\Z")
OPAQUE_ID_RE = re.compile(r"\A[a-f0-9]{32}\Z")
MEDIA_OBJECT_KEY_RE = re.compile(r"\A[a-f0-9]{64}\Z")
SHA256_RE = re.compile(r"\A[a-f0-9]{64}\Z")
ALLOWED_MEDIA_MIMES = {"image/jpeg"}
PASSWORD_SCRYPT_N = 2**14
SESSION_SECONDS = 8 * 60 * 60


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _new_id() -> str:
    return uuid.uuid4().hex


def _token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _clean_text(
    value: Any,
    field: str,
    maximum: int,
    *,
    minimum: int = 1,
    allow_empty: bool = False,
) -> str:
    if not isinstance(value, str):
        raise StoreValidationError(f"{field} must be text.")
    cleaned = " ".join(value.split()).strip()
    if any(unicodedata.category(char).startswith("C") for char in cleaned):
        raise StoreValidationError(f"{field} contains unsupported characters.")
    if not cleaned and allow_empty:
        return ""
    if not minimum <= len(cleaned) <= maximum:
        raise StoreValidationError(f"{field} must be between {minimum} and {maximum} characters.")
    return cleaned


def _email(value: Any) -> str:
    if not isinstance(value, str):
        raise StoreValidationError("email must be text.")
    normalized = value.strip().casefold()
    if len(normalized) > 254 or not EMAIL_RE.fullmatch(normalized):
        raise StoreValidationError("Enter a valid email address.")
    return normalized


def _password(value: Any) -> str:
    if not isinstance(value, str) or len(value) < 14 or len(value) > 200:
        raise StoreValidationError("Password must be between 14 and 200 characters.")
    if not (
        any(char.islower() for char in value)
        and any(char.isupper() for char in value)
        and any(char.isdigit() for char in value)
        and any(not char.isalnum() for char in value)
    ):
        raise StoreValidationError("Password must include upper- and lowercase letters, a number, and a symbol.")
    return value


def _password_digest(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=PASSWORD_SCRYPT_N,
        r=8,
        p=1,
        dklen=32,
    )


class CareviewStore:
    """Small SQLite store with one connection per operation."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        try:
            yield connection
        except Exception:
            connection.rollback()
            raise
        else:
            connection.commit()
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS workspaces (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                    display_name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_salt BLOB NOT NULL,
                    password_hash BLOB NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    csrf_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS patients (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                    display_name TEXT NOT NULL,
                    care_location TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS patients_workspace_name
                    ON patients(workspace_id, display_name COLLATE NOCASE);
                CREATE TABLE IF NOT EXISTS scenes (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
                    created_by TEXT NOT NULL REFERENCES users(id),
                    zone TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    duration_seconds REAL,
                    frames_submitted INTEGER NOT NULL,
                    assessment_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS scenes_patient_created
                    ON scenes(workspace_id, patient_id, created_at DESC);
                CREATE TABLE IF NOT EXISTS scene_media (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
                    scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
                    object_key TEXT NOT NULL UNIQUE,
                    mime_type TEXT NOT NULL,
                    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
                    sha256 TEXT NOT NULL,
                    width INTEGER,
                    height INTEGER,
                    frame_number INTEGER NOT NULL CHECK (frame_number > 0),
                    timestamp_ms INTEGER,
                    created_by TEXT NOT NULL REFERENCES users(id),
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS scene_media_scene
                    ON scene_media(workspace_id, patient_id, scene_id, frame_number);
                CREATE TABLE IF NOT EXISTS findings (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
                    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
                    scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
                    finding_json TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'resolved', 'dismissed')),
                    note TEXT NOT NULL DEFAULT '',
                    version INTEGER NOT NULL DEFAULT 1,
                    reviewed_by TEXT REFERENCES users(id),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS findings_scene ON findings(scene_id);
                CREATE TABLE IF NOT EXISTS audit_events (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT,
                    actor_user_id TEXT,
                    patient_id TEXT,
                    action TEXT NOT NULL,
                    outcome TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )

    @staticmethod
    def _public_user(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "displayName": row["display_name"],
            "email": row["email"],
            "role": row["role"],
            "workspaceId": row["workspace_id"],
            "workspaceName": row["workspace_name"],
            "createdAt": row["created_at"],
        }

    @staticmethod
    def _public_patient(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "displayName": row["display_name"],
            "careLocation": row["care_location"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    @staticmethod
    def _validate_context(context: Any) -> tuple[str, str]:
        if not isinstance(context, dict):
            raise AuthenticationError("Invalid session.")
        workspace_id = context.get("workspaceId")
        user_id = context.get("userId")
        if not isinstance(workspace_id, str) or not isinstance(user_id, str):
            raise AuthenticationError("Invalid session.")
        return workspace_id, user_id

    @staticmethod
    def _validate_id(value: Any, field: str) -> str:
        if not isinstance(value, str) or not OPAQUE_ID_RE.fullmatch(value):
            raise StoreValidationError(f"Invalid {field}.")
        return value

    @staticmethod
    def _audit(
        connection: sqlite3.Connection,
        action: str,
        *,
        workspace_id: str | None = None,
        actor_user_id: str | None = None,
        patient_id: str | None = None,
        outcome: str = "success",
    ) -> None:
        connection.execute(
            "INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?)",
            (_new_id(), workspace_id, actor_user_id, patient_id, action, outcome, _now_iso()),
        )

    def setup_required(self) -> bool:
        with self._connect() as connection:
            return connection.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0

    def _create_session(
        self, connection: sqlite3.Connection, user_id: str
    ) -> tuple[str, str]:
        raw_token = secrets.token_urlsafe(32)
        raw_csrf = secrets.token_urlsafe(32)
        hashed_token = _token_hash(raw_token)
        connection.execute(
            "INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
            (
                hashed_token,
                user_id,
                _token_hash(raw_csrf),
                _now_iso(),
                int(time.time()) + SESSION_SECONDS,
            ),
        )
        return raw_token, raw_csrf

    def setup(
        self, workspace_name: Any, display_name: Any, email: Any, password: Any
    ) -> tuple[dict[str, Any], str, str]:
        workspace_name = _clean_text(workspace_name, "workspaceName", 80, minimum=2)
        display_name = _clean_text(display_name, "displayName", 100, minimum=2)
        email = _email(email)
        password = _password(password)
        salt = secrets.token_bytes(16)
        digest = _password_digest(password, salt)
        workspace_id = _new_id()
        user_id = _new_id()
        created_at = _now_iso()
        try:
            with self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                if connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
                    raise ConflictError("Initial setup has already been completed.")
                connection.execute(
                    "INSERT INTO workspaces VALUES (?, ?, ?)",
                    (workspace_id, workspace_name, created_at),
                )
                connection.execute(
                    "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, 'admin', 1, ?)",
                    (user_id, workspace_id, display_name, email, salt, digest, created_at),
                )
                token, csrf = self._create_session(connection, user_id)
                self._audit(
                    connection,
                    "workspace.setup",
                    workspace_id=workspace_id,
                    actor_user_id=user_id,
                )
                row = connection.execute(
                    """SELECT users.*, workspaces.name AS workspace_name
                       FROM users JOIN workspaces ON workspaces.id = users.workspace_id
                       WHERE users.id = ?""",
                    (user_id,),
                ).fetchone()
        except sqlite3.IntegrityError as exc:
            raise ConflictError("That email address is already in use.") from exc
        return self._public_user(row), token, csrf

    def login(self, email: Any, password: Any) -> tuple[dict[str, Any], str, str] | None:
        try:
            email = _email(email)
        except StoreValidationError:
            email = "invalid@example.invalid"
        supplied = password if isinstance(password, str) and len(password) <= 200 else ""
        with self._connect() as connection:
            row = connection.execute(
                """SELECT users.*, workspaces.name AS workspace_name
                   FROM users JOIN workspaces ON workspaces.id = users.workspace_id
                   WHERE users.email = ? COLLATE NOCASE AND users.active = 1""",
                (email,),
            ).fetchone()
            if row is None:
                # Keep the absent-user path computationally similar to a failed password.
                salt = b"careview-login-fallback-salt"
                expected = _password_digest("CareviewFallback!Password1", salt)
                actual = _password_digest(supplied, salt)
                hmac.compare_digest(expected, actual)
                return None
            actual = _password_digest(supplied, bytes(row["password_salt"]))
            if not hmac.compare_digest(bytes(row["password_hash"]), actual):
                return None
            connection.execute(
                "DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),)
            )
            token, csrf = self._create_session(connection, row["id"])
            self._audit(
                connection,
                "auth.login",
                workspace_id=row["workspace_id"],
                actor_user_id=row["id"],
            )
            return self._public_user(row), token, csrf

    def authenticate(self, raw_token: Any) -> dict[str, Any]:
        if not isinstance(raw_token, str):
            raise AuthenticationError("Invalid session.")
        hashed_token = _token_hash(raw_token)
        with self._connect() as connection:
            row = connection.execute(
                """SELECT sessions.token_hash, sessions.csrf_hash, sessions.expires_at,
                          users.*, workspaces.name AS workspace_name
                   FROM sessions
                   JOIN users ON users.id = sessions.user_id
                   JOIN workspaces ON workspaces.id = users.workspace_id
                   WHERE sessions.token_hash = ? AND users.active = 1""",
                (hashed_token,),
            ).fetchone()
            if row is None or row["expires_at"] <= int(time.time()):
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (hashed_token,))
                raise AuthenticationError("Session expired.")
            return {
                "sessionHash": hashed_token,
                "workspaceId": row["workspace_id"],
                "userId": row["id"],
                "user": self._public_user(row),
                "expiresAt": row["expires_at"],
            }

    def verify_csrf(self, context: Any, supplied: Any) -> bool:
        try:
            self._validate_context(context)
            session_hash = context["sessionHash"]
        except (AuthenticationError, KeyError):
            return False
        if not isinstance(supplied, str):
            return False
        with self._connect() as connection:
            row = connection.execute(
                "SELECT csrf_hash FROM sessions WHERE token_hash = ? AND expires_at > ?",
                (session_hash, int(time.time())),
            ).fetchone()
        return row is not None and hmac.compare_digest(row["csrf_hash"], _token_hash(supplied))

    def logout(self, context: Any) -> None:
        workspace_id, user_id = self._validate_context(context)
        session_hash = context.get("sessionHash")
        if not isinstance(session_hash, str):
            raise AuthenticationError("Invalid session.")
        with self._connect() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (session_hash,))
            self._audit(
                connection,
                "auth.logout",
                workspace_id=workspace_id,
                actor_user_id=user_id,
            )

    def _require_admin(self, context: Any) -> tuple[str, str]:
        workspace_id, user_id = self._validate_context(context)
        if context.get("user", {}).get("role") != "admin":
            raise AuthorizationError("Administrator access is required.")
        return workspace_id, user_id

    def create_user(
        self, context: Any, display_name: Any, email: Any, password: Any
    ) -> dict[str, Any]:
        workspace_id, actor_id = self._require_admin(context)
        display_name = _clean_text(display_name, "displayName", 100, minimum=2)
        email = _email(email)
        password = _password(password)
        salt = secrets.token_bytes(16)
        digest = _password_digest(password, salt)
        user_id = _new_id()
        created_at = _now_iso()
        try:
            with self._connect() as connection:
                connection.execute(
                    "INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, 'staff', 1, ?)",
                    (user_id, workspace_id, display_name, email, salt, digest, created_at),
                )
                self._audit(
                    connection,
                    "user.create",
                    workspace_id=workspace_id,
                    actor_user_id=actor_id,
                )
                row = connection.execute(
                    """SELECT users.*, workspaces.name AS workspace_name
                       FROM users JOIN workspaces ON workspaces.id = users.workspace_id
                       WHERE users.id = ?""",
                    (user_id,),
                ).fetchone()
        except sqlite3.IntegrityError as exc:
            raise ConflictError("That email address is already in use.") from exc
        return self._public_user(row)

    def list_users(self, context: Any) -> list[dict[str, Any]]:
        workspace_id, _ = self._require_admin(context)
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT users.*, workspaces.name AS workspace_name
                   FROM users JOIN workspaces ON workspaces.id = users.workspace_id
                   WHERE users.workspace_id = ? AND users.active = 1
                   ORDER BY users.display_name COLLATE NOCASE""",
                (workspace_id,),
            ).fetchall()
        return [self._public_user(row) for row in rows]

    def create_patient(
        self, context: Any, display_name: Any, care_location: Any
    ) -> dict[str, Any]:
        workspace_id, actor_id = self._validate_context(context)
        display_name = _clean_text(display_name, "displayName", 120, minimum=2)
        care_location = _clean_text(
            care_location, "careLocation", 120, allow_empty=True
        )
        patient_id = _new_id()
        timestamp = _now_iso()
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO patients VALUES (?, ?, ?, ?, ?, ?)",
                (patient_id, workspace_id, display_name, care_location, timestamp, timestamp),
            )
            self._audit(
                connection,
                "patient.create",
                workspace_id=workspace_id,
                actor_user_id=actor_id,
                patient_id=patient_id,
            )
            row = connection.execute(
                "SELECT * FROM patients WHERE id = ?", (patient_id,)
            ).fetchone()
        return self._public_patient(row)

    def list_patients(self, context: Any, query: Any = "") -> list[dict[str, Any]]:
        workspace_id, _ = self._validate_context(context)
        if not isinstance(query, str) or len(query) > 120:
            raise StoreValidationError("Patient search is invalid.")
        query = " ".join(query.split()).strip()
        with self._connect() as connection:
            if query:
                escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                rows = connection.execute(
                    """SELECT * FROM patients
                       WHERE workspace_id = ? AND display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
                       ORDER BY display_name COLLATE NOCASE LIMIT 20""",
                    (workspace_id, f"%{escaped}%"),
                ).fetchall()
            else:
                rows = connection.execute(
                    """SELECT * FROM patients WHERE workspace_id = ?
                       ORDER BY display_name COLLATE NOCASE LIMIT 50""",
                    (workspace_id,),
                ).fetchall()
        return [self._public_patient(row) for row in rows]

    def get_patient(self, context: Any, patient_id: Any) -> dict[str, Any]:
        workspace_id, _ = self._validate_context(context)
        patient_id = self._validate_id(patient_id, "patient id")
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM patients WHERE id = ? AND workspace_id = ?",
                (patient_id, workspace_id),
            ).fetchone()
        if row is None:
            raise NotFoundError("Patient not found.")
        return self._public_patient(row)

    @staticmethod
    def _public_finding(row: sqlite3.Row) -> dict[str, Any]:
        value = json.loads(row["finding_json"])
        value.update(
            {
                "id": row["id"],
                "status": row["status"],
                "note": row["note"],
                "version": row["version"],
                "updatedAt": row["updated_at"],
                "reviewedBy": (
                    {"id": row["reviewed_by"], "displayName": row["reviewer_name"]}
                    if row["reviewed_by"] and row["reviewer_name"]
                    else None
                ),
            }
        )
        return value

    @staticmethod
    def _public_media(row: sqlite3.Row) -> dict[str, Any]:
        patient_id = row["patient_id"]
        scene_id = row["scene_id"]
        media_id = row["id"]
        return {
            "id": media_id,
            "url": f"/api/patients/{patient_id}/scenes/{scene_id}/media/{media_id}",
            "mimeType": row["mime_type"],
            "byteSize": row["byte_size"],
            "sha256": row["sha256"],
            "width": row["width"],
            "height": row["height"],
            "frameNumber": row["frame_number"],
            "timestampMs": row["timestamp_ms"],
            "createdAt": row["created_at"],
            "createdBy": {
                "id": row["created_by"],
                "displayName": row["media_creator_name"],
            },
        }

    def _scene_from_row(
        self, connection: sqlite3.Connection, row: sqlite3.Row
    ) -> dict[str, Any]:
        assessment = json.loads(row["assessment_json"])
        finding_rows = connection.execute(
            """SELECT findings.*, users.display_name AS reviewer_name
               FROM findings LEFT JOIN users ON users.id = findings.reviewed_by
               WHERE findings.scene_id = ? ORDER BY findings.created_at, findings.id""",
            (row["id"],),
        ).fetchall()
        media_rows = connection.execute(
            """SELECT scene_media.*, users.display_name AS media_creator_name
               FROM scene_media JOIN users ON users.id = scene_media.created_by
               WHERE scene_media.scene_id = ?
               ORDER BY scene_media.frame_number, scene_media.id""",
            (row["id"],),
        ).fetchall()
        assessment["findings"] = [self._public_finding(item) for item in finding_rows]
        return {
            "id": row["id"],
            "patientId": row["patient_id"],
            "zone": row["zone"],
            "zoneLabel": {
                "kitchen": "Kitchen",
                "fridge": "Fridge & freezer",
                "medication": "Medication area",
                "living": "Living space",
            }.get(row["zone"], row["zone"]),
            "mediaType": row["media_type"],
            "durationSeconds": row["duration_seconds"],
            "framesSubmitted": row["frames_submitted"],
            "createdAt": row["created_at"],
            "createdBy": {"id": row["created_by"], "displayName": row["creator_name"]},
            "assessment": assessment,
            "media": [self._public_media(item) for item in media_rows],
        }

    def create_scene(
        self,
        context: Any,
        patient_id: Any,
        metadata: Any,
        assessment: Any,
        media: Any = None,
    ) -> dict[str, Any]:
        workspace_id, actor_id = self._validate_context(context)
        patient_id = self._validate_id(patient_id, "patient id")
        if not isinstance(metadata, dict) or not isinstance(assessment, dict):
            raise StoreValidationError("Scene data is invalid.")
        zone = metadata.get("zone")
        media_type = metadata.get("mediaType")
        duration = metadata.get("durationSeconds")
        frames_submitted = metadata.get("framesSubmitted")
        if zone not in {"kitchen", "fridge", "medication", "living"}:
            raise StoreValidationError("Scene zone is invalid.")
        if media_type not in {"image", "video"}:
            raise StoreValidationError("Scene media type is invalid.")
        if not isinstance(frames_submitted, int) or not 1 <= frames_submitted <= 6:
            raise StoreValidationError("Scene frame count is invalid.")
        findings = assessment.get("findings")
        if not isinstance(findings, list) or len(findings) > 6:
            raise StoreValidationError("Scene findings are invalid.")
        if media is None:
            media = []
        if not isinstance(media, list) or len(media) not in {0, frames_submitted}:
            raise StoreValidationError("Scene media metadata is invalid.")
        validated_media: list[dict[str, Any]] = []
        frame_numbers: set[int] = set()
        for item in media:
            if not isinstance(item, dict) or set(item) != {
                "id",
                "objectKey",
                "mimeType",
                "byteSize",
                "sha256",
                "width",
                "height",
                "frameNumber",
                "timestampMs",
            }:
                raise StoreValidationError("Scene media metadata is invalid.")
            media_id = self._validate_id(item["id"], "media id")
            object_key = item["objectKey"]
            checksum = item["sha256"]
            mime_type_value = item["mimeType"]
            byte_size = item["byteSize"]
            width = item["width"]
            height = item["height"]
            frame_number = item["frameNumber"]
            timestamp_ms = item["timestampMs"]
            if not isinstance(object_key, str) or not MEDIA_OBJECT_KEY_RE.fullmatch(object_key):
                raise StoreValidationError("Scene media object key is invalid.")
            if not isinstance(checksum, str) or not SHA256_RE.fullmatch(checksum):
                raise StoreValidationError("Scene media checksum is invalid.")
            if mime_type_value not in ALLOWED_MEDIA_MIMES:
                raise StoreValidationError("Scene media type is invalid.")
            if (
                not isinstance(byte_size, int)
                or isinstance(byte_size, bool)
                or not 1 <= byte_size <= 4 * 1024 * 1024
            ):
                raise StoreValidationError("Scene media byte size is invalid.")
            if (
                not isinstance(width, int)
                or isinstance(width, bool)
                or not 1 <= width <= 1280
                or not isinstance(height, int)
                or isinstance(height, bool)
                or not 1 <= height <= 1280
            ):
                raise StoreValidationError("Scene media dimensions are invalid.")
            if (
                not isinstance(frame_number, int)
                or isinstance(frame_number, bool)
                or not 1 <= frame_number <= frames_submitted
                or frame_number in frame_numbers
            ):
                raise StoreValidationError("Scene media frame number is invalid.")
            if timestamp_ms is not None and (
                not isinstance(timestamp_ms, int)
                or isinstance(timestamp_ms, bool)
                or not 0 <= timestamp_ms <= 30_000
            ):
                raise StoreValidationError("Scene media timestamp is invalid.")
            if media_type == "image" and timestamp_ms is not None:
                raise StoreValidationError("Still-image evidence cannot have a timestamp.")
            if media_type == "video" and timestamp_ms is None:
                raise StoreValidationError("Video-frame evidence requires a timestamp.")
            frame_numbers.add(frame_number)
            validated_media.append(
                {
                    "id": media_id,
                    "objectKey": object_key,
                    "mimeType": mime_type_value,
                    "byteSize": byte_size,
                    "sha256": checksum,
                    "width": width,
                    "height": height,
                    "frameNumber": frame_number,
                    "timestampMs": timestamp_ms,
                }
            )
        assessment_base = dict(assessment)
        assessment_base.pop("findings", None)
        # A defensive size ceiling prevents accidental storage of media-like payloads.
        encoded_assessment = json.dumps(assessment_base, separators=(",", ":"), ensure_ascii=False)
        if len(encoded_assessment.encode("utf-8")) > 32 * 1024 or "data:image" in encoded_assessment:
            raise StoreValidationError("Derived assessment is too large.")
        scene_id = _new_id()
        timestamp = _now_iso()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            patient = connection.execute(
                "SELECT id FROM patients WHERE id = ? AND workspace_id = ?",
                (patient_id, workspace_id),
            ).fetchone()
            if patient is None:
                raise NotFoundError("Patient not found.")
            connection.execute(
                "INSERT INTO scenes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    scene_id,
                    workspace_id,
                    patient_id,
                    actor_id,
                    zone,
                    media_type,
                    duration,
                    frames_submitted,
                    encoded_assessment,
                    timestamp,
                ),
            )
            for item in validated_media:
                connection.execute(
                    """INSERT INTO scene_media
                       (id, workspace_id, patient_id, scene_id, object_key, mime_type,
                        byte_size, sha256, width, height, frame_number, timestamp_ms,
                        created_by, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        item["id"],
                        workspace_id,
                        patient_id,
                        scene_id,
                        item["objectKey"],
                        item["mimeType"],
                        item["byteSize"],
                        item["sha256"],
                        item["width"],
                        item["height"],
                        item["frameNumber"],
                        item["timestampMs"],
                        actor_id,
                        timestamp,
                    ),
                )
            for finding in findings:
                if not isinstance(finding, dict):
                    raise StoreValidationError("A derived finding is invalid.")
                safe_finding = dict(finding)
                safe_finding.pop("id", None)
                encoded_finding = json.dumps(safe_finding, separators=(",", ":"), ensure_ascii=False)
                if len(encoded_finding.encode("utf-8")) > 16 * 1024 or "data:image" in encoded_finding:
                    raise StoreValidationError("A derived finding is too large.")
                connection.execute(
                    """INSERT INTO findings
                       (id, workspace_id, patient_id, scene_id, finding_json, status, note,
                        version, reviewed_by, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, 'pending', '', 1, NULL, ?, ?)""",
                    (
                        _new_id(),
                        workspace_id,
                        patient_id,
                        scene_id,
                        encoded_finding,
                        timestamp,
                        timestamp,
                    ),
                )
            self._audit(
                connection,
                "scene.create",
                workspace_id=workspace_id,
                actor_user_id=actor_id,
                patient_id=patient_id,
            )
            row = connection.execute(
                """SELECT scenes.*, users.display_name AS creator_name
                   FROM scenes JOIN users ON users.id = scenes.created_by
                   WHERE scenes.id = ?""",
                (scene_id,),
            ).fetchone()
            return self._scene_from_row(connection, row)

    def list_media_object_keys(self) -> set[str]:
        """Return the opaque filesystem keys currently committed in SQLite."""
        with self._connect() as connection:
            rows = connection.execute("SELECT object_key FROM scene_media").fetchall()
        keys = {row["object_key"] for row in rows}
        if any(not MEDIA_OBJECT_KEY_RE.fullmatch(key) for key in keys):
            raise StoreValidationError("Stored scene media metadata is invalid.")
        return keys

    def get_scene_media(
        self,
        context: Any,
        patient_id: Any,
        scene_id: Any,
        media_id: Any,
    ) -> dict[str, Any]:
        """Return an authorized media record, including its server-only object key."""
        workspace_id, _ = self._validate_context(context)
        patient_id = self._validate_id(patient_id, "patient id")
        scene_id = self._validate_id(scene_id, "scene id")
        media_id = self._validate_id(media_id, "media id")
        with self._connect() as connection:
            row = connection.execute(
                """SELECT scene_media.*, users.display_name AS media_creator_name
                   FROM scene_media JOIN users ON users.id = scene_media.created_by
                   WHERE scene_media.id = ? AND scene_media.workspace_id = ?
                     AND scene_media.patient_id = ? AND scene_media.scene_id = ?""",
                (media_id, workspace_id, patient_id, scene_id),
            ).fetchone()
        if row is None:
            raise NotFoundError("Scene media not found.")
        result = self._public_media(row)
        result["objectKey"] = row["object_key"]
        return result

    def list_scenes(self, context: Any, patient_id: Any) -> list[dict[str, Any]]:
        workspace_id, _ = self._validate_context(context)
        patient_id = self._validate_id(patient_id, "patient id")
        with self._connect() as connection:
            patient = connection.execute(
                "SELECT id FROM patients WHERE id = ? AND workspace_id = ?",
                (patient_id, workspace_id),
            ).fetchone()
            if patient is None:
                raise NotFoundError("Patient not found.")
            rows = connection.execute(
                """SELECT scenes.*, users.display_name AS creator_name
                   FROM scenes JOIN users ON users.id = scenes.created_by
                   WHERE scenes.patient_id = ? AND scenes.workspace_id = ?
                   ORDER BY scenes.created_at DESC, scenes.id DESC LIMIT 100""",
                (patient_id, workspace_id),
            ).fetchall()
            return [self._scene_from_row(connection, row) for row in rows]

    def update_finding(
        self,
        context: Any,
        patient_id: Any,
        finding_id: Any,
        status: Any,
        note: Any,
        version: Any,
    ) -> dict[str, Any]:
        workspace_id, actor_id = self._validate_context(context)
        patient_id = self._validate_id(patient_id, "patient id")
        finding_id = self._validate_id(finding_id, "finding id")
        if status not in {"pending", "confirmed", "resolved", "dismissed"}:
            raise StoreValidationError("Review status is invalid.")
        note = _clean_text(note, "note", 1000, allow_empty=True)
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise StoreValidationError("Review version is invalid.")
        timestamp = _now_iso()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """SELECT findings.*, users.display_name AS reviewer_name
                   FROM findings LEFT JOIN users ON users.id = findings.reviewed_by
                   WHERE findings.id = ? AND findings.patient_id = ? AND findings.workspace_id = ?""",
                (finding_id, patient_id, workspace_id),
            ).fetchone()
            if row is None:
                raise NotFoundError("Finding not found.")
            if row["version"] != version:
                raise ConflictError(
                    "The finding has changed.", current=self._public_finding(row)
                )
            connection.execute(
                """UPDATE findings SET status = ?, note = ?, version = version + 1,
                          reviewed_by = ?, updated_at = ? WHERE id = ?""",
                (status, note, actor_id, timestamp, finding_id),
            )
            self._audit(
                connection,
                "finding.review",
                workspace_id=workspace_id,
                actor_user_id=actor_id,
                patient_id=patient_id,
            )
            updated = connection.execute(
                """SELECT findings.*, users.display_name AS reviewer_name
                   FROM findings LEFT JOIN users ON users.id = findings.reviewed_by
                   WHERE findings.id = ?""",
                (finding_id,),
            ).fetchone()
            return self._public_finding(updated)
