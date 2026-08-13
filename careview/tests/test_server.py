import base64
import http.client
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402


def data_url(payload=b"small-image", mime="image/jpeg"):
    signatures = {
        "image/jpeg": b"\xff\xd8\xff",
        "image/png": b"\x89PNG\r\n\x1a\n",
        "image/webp": b"RIFF\x08\x00\x00\x00WEBP",
        "image/gif": b"GIF89a",
    }
    content = signatures.get(mime, b"") + payload
    return f"data:{mime};base64,{base64.b64encode(content).decode('ascii')}"


def image_payload(**changes):
    payload = {
        "zone": "kitchen",
        "zoneLabel": "Kitchen",
        "mediaType": "image",
        "durationSeconds": None,
        "frames": [
            {
                "dataUrl": data_url(),
                "timestampSeconds": 0,
                "width": 800,
                "height": 600,
            }
        ],
    }
    payload.update(changes)
    return payload


def video_payload():
    return {
        "zone": "fridge",
        "zoneLabel": "Fridge & freezer",
        "mediaType": "video",
        "durationSeconds": 3,
        "frames": [
            {"dataUrl": data_url(b"frame-one", "image/png"), "timestampSeconds": 0},
            {"dataUrl": data_url(b"frame-two", "image/webp"), "timestampSeconds": 2.5},
        ],
    }


def model_result(**changes):
    result = {
        "status": "completed",
        "summary": "Two submitted frames were visually assessed.",
        "limitations": ["Items outside the frame are not visible."],
        "findings": [
            {
                "category": "Food",
                "title": "Open container is visible",
                "observed": "An uncovered food container is visible on a refrigerator shelf.",
                "caregiverCheck": "Check the container and storage conditions in person.",
                "urgency": "monitor",
                "limitation": "The contents and storage duration cannot be established visually.",
                "evidenceFrameNumbers": [2],
            }
        ],
    }
    result.update(changes)
    return result


def responses_envelope(result):
    return {
        "status": "completed",
        "output": [
            {
                "type": "message",
                "content": [{"type": "output_text", "text": json.dumps(result)}],
            }
        ],
    }


class FakeResponse:
    def __init__(self, value):
        self.body = json.dumps(value).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, amount=-1):
        return self.body if amount < 0 else self.body[:amount]


@contextmanager
def running_server():
    with tempfile.TemporaryDirectory() as temporary:
        db_path = Path(temporary) / "careview.db"
        httpd = server.create_server("127.0.0.1", 0, ROOT, db_path)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            yield httpd.server_port
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)


def request(port, method, path, body=None, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    encoded = None if body is None else json.dumps(body).encode("utf-8")
    final_headers = dict(headers or {})
    if encoded is not None:
        final_headers.setdefault("Content-Type", "application/json")
    connection.request(method, path, body=encoded, headers=final_headers)
    response = connection.getresponse()
    payload = response.read()
    result = (response.status, dict(response.getheaders()), payload)
    connection.close()
    return result


class ApiClient:
    def __init__(self, port):
        self.port = port
        self.cookie = ""
        self.csrf = ""

    def request(self, method, path, body=None, *, csrf=False, headers=None):
        final_headers = dict(headers or {})
        if self.cookie:
            final_headers["Cookie"] = self.cookie
        if csrf:
            final_headers["X-CSRF-Token"] = self.csrf
        status, response_headers, raw = request(self.port, method, path, body, final_headers)
        set_cookie = response_headers.get("Set-Cookie")
        if set_cookie:
            self.cookie = set_cookie.split(";", 1)[0]
        try:
            parsed = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed = raw
        if isinstance(parsed, dict) and isinstance(parsed.get("csrfToken"), str):
            self.csrf = parsed["csrfToken"]
        return status, response_headers, parsed

    def setup(self, *, email="admin@example.test", password="CareviewStrong!Passphrase42"):
        return self.request(
            "POST",
            "/api/setup",
            {
                "workspaceName": "Northstar Care",
                "displayName": "Alex Admin",
                "email": email,
                "password": password,
            },
        )

    def login(self, email, password):
        return self.request("POST", "/api/login", {"email": email, "password": password})


class ValidationTests(unittest.TestCase):
    def test_strict_output_schema_avoids_unsupported_keywords(self):
        encoded = json.dumps(server.OUTPUT_SCHEMA)
        self.assertNotIn('"maxLength"', encoded)
        self.assertNotIn('"uniqueItems"', encoded)

    def test_accepts_image_and_frontend_video_timestamp_shape(self):
        image = server.validate_analysis_payload(image_payload())
        video = server.validate_analysis_payload(video_payload())

        self.assertIsNone(image.frames[0].timestamp_ms)
        self.assertEqual((video.frames[0].timestamp_ms, video.frames[1].timestamp_ms), (0, 2500))
        self.assertEqual((image.frames[0].width, image.frames[0].height), (800, 600))

    def test_rejects_unknown_zone_fields_and_raw_video(self):
        bad_zone = image_payload(zone="bedroom")
        with self.assertRaises(server.RequestValidationError):
            server.validate_analysis_payload(bad_zone)

        extra = image_payload()
        extra["frames"][0]["personName"] = "private"
        with self.assertRaises(server.RequestValidationError):
            server.validate_analysis_payload(extra)

        raw_video = image_payload()
        raw_video["frames"][0]["dataUrl"] = data_url(b"video", "video/mp4")
        with self.assertRaises(server.RequestValidationError):
            server.validate_analysis_payload(raw_video)

    def test_rejects_bad_counts_base64_and_timestamps(self):
        too_many = video_payload()
        too_many["frames"] = too_many["frames"] * 4
        with self.assertRaises(server.RequestValidationError):
            server.validate_analysis_payload(too_many)

        bad_base64 = image_payload()
        bad_base64["frames"][0]["dataUrl"] = "data:image/jpeg;base64,not+valid="
        with self.assertRaises(server.RequestValidationError):
            server.validate_analysis_payload(bad_base64)

        timestamps = video_payload()
        timestamps["frames"][1]["timestampSeconds"] = 0
        with self.assertRaises(server.RequestValidationError):
            server.validate_analysis_payload(timestamps)

        wrong_signature = image_payload()
        wrong_signature["frames"][0]["dataUrl"] = (
            "data:image/jpeg;base64," + base64.b64encode(b"not-an-image").decode("ascii")
        )
        with self.assertRaises(server.RequestValidationError):
            server.validate_analysis_payload(wrong_signature)


class NormalizationTests(unittest.TestCase):
    def test_caps_and_sanitizes_hostile_output_and_medication_actions(self):
        validated = server.validate_analysis_payload(video_payload())
        raw = model_result(
            summary="Visible review <script>alert(1)</script> contact x@example.com " + "x" * 500,
            findings=[
                {
                    "category": "Medication",
                    "title": "Organizer <img src=x onerror=alert(1)> visible",
                    "observed": "A numbered organizer [redacted] is visible.",
                    "caregiverCheck": "Immediately double the dose and call 911.",
                    "urgency": "now",
                    "limitation": "The contents cannot be verified.",
                    "evidenceFrameNumbers": [1, 2, 2],
                }
            ],
        )

        result = server._normalize_model_output(raw, validated, "test-model")
        finding = result["findings"][0]
        self.assertLessEqual(len(result["summary"]), 320)
        self.assertNotIn("<", result["summary"] + finding["title"])
        self.assertNotIn("x@example.com", result["summary"])
        self.assertEqual(finding["urgency"], "soon")
        self.assertIn("Do not change any medication dose or schedule", finding["action"])
        self.assertEqual(finding["evidenceFrameNumbers"], [1, 2])
        self.assertEqual(finding["evidenceTimestampsMs"], [0, 2500])

    def test_drops_sensitive_inferences_and_distinguishes_empty_assessment(self):
        validated = server.validate_analysis_payload(image_payload())
        unsafe = model_result()
        unsafe["findings"][0]["observed"] = "This proves medication non-adherence."
        result = server._normalize_model_output(unsafe, validated, "test-model")

        self.assertFalse(result["unable_to_assess"])
        self.assertEqual(result["assessmentOutcome"], "assessed_no_findings")
        self.assertEqual(result["findings"], [])
        self.assertIn("non-emergency", " ".join(result["limitations"]).lower())

    def test_drops_missed_dose_claims_and_neutralizes_emergency_summaries(self):
        validated = server.validate_analysis_payload(image_payload())
        unsafe = model_result(summary="Call an ambulance now because this looks dangerous.")
        unsafe["findings"][0]["observed"] = "The Tuesday dose appears to have been missed."
        result = server._normalize_model_output(unsafe, validated, "test-model")

        self.assertEqual(result["findings"], [])
        self.assertNotIn("ambulance", result["summary"].lower())
        self.assertEqual(result["assessmentOutcome"], "assessed_no_findings")

    def test_unable_status_is_distinct_and_has_no_findings(self):
        validated = server.validate_analysis_payload(image_payload())
        raw = model_result(
            status="unable_to_assess",
            summary="The image is too dark to assess.",
            findings=[],
        )
        result = server._normalize_model_output(raw, validated, "test-model")

        self.assertTrue(result["unable_to_assess"])
        self.assertEqual(result["assessmentOutcome"], "unable_to_assess")
        self.assertEqual(result["framesSubmitted"], 1)
        self.assertNotIn("framesAnalyzed", result)


class EndpointTests(unittest.TestCase):
    password = "CareviewStrong!Passphrase42"

    def create_patient(self, client, name="Margaret Ellis", location="Home"):
        status, _, body = client.request(
            "POST",
            "/api/patients",
            {"displayName": name, "careLocation": location},
            csrf=True,
        )
        self.assertEqual(status, 201, body)
        return body["patient"]

    def create_staff(self, client, email="nurse@example.test"):
        status, _, body = client.request(
            "POST",
            "/api/users",
            {
                "displayName": "Nora Nurse",
                "email": email,
                "password": self.password,
            },
            csrf=True,
        )
        self.assertEqual(status, 201, body)
        return body["user"]

    def test_health_session_and_static_security_headers(self):
        with running_server() as port:
            status, headers, body = request(port, "GET", "/api/health")
            self.assertEqual(status, 200)
            health = json.loads(body)
            self.assertEqual(health["status"], "ok")
            self.assertIsInstance(health["aiConfigured"], bool)
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
            self.assertEqual(headers["Referrer-Policy"], "no-referrer")
            self.assertEqual(headers["X-Frame-Options"], "DENY")

            status, _, session = ApiClient(port).request("GET", "/api/session")
            self.assertEqual(status, 200)
            self.assertEqual(session, {"authenticated": False, "setupRequired": True})

            status, headers, body = request(port, "GET", "/")
            self.assertEqual(status, 200)
            self.assertIn(b"Careview", body)
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")

    def test_static_allowlist_and_old_analyze_endpoint_are_closed(self):
        with running_server() as port:
            for path in (
                "/server.py",
                "/.gitignore",
                "/tests/test_server.py",
                "/scripts/generate-icons.py",
                "/__pycache__/server.pyc",
                "/../server.py",
            ):
                status, _, _ = request(port, "GET", path)
                self.assertEqual(status, 404, path)
            status, _, body = ApiClient(port).request("POST", "/api/analyze", image_payload())
            self.assertEqual(status, 404)
            self.assertEqual(body["error"]["code"], "not_found")

    def test_setup_is_one_time_and_session_cookie_is_hardened(self):
        with running_server() as port:
            client = ApiClient(port)
            status, headers, body = client.setup(password=self.password)
            self.assertEqual(status, 201, body)
            self.assertEqual(body["user"]["role"], "admin")
            cookie = headers["Set-Cookie"]
            self.assertIn("HttpOnly", cookie)
            self.assertIn("SameSite=Strict", cookie)
            self.assertIn("Path=/", cookie)
            self.assertIn("Max-Age=28800", cookie)
            self.assertNotIn(self.password, json.dumps(body))

            status, _, session = client.request("GET", "/api/session")
            self.assertEqual(status, 200)
            self.assertTrue(session["authenticated"])
            self.assertFalse(session["setupRequired"])
            self.assertEqual(session["user"]["email"], "admin@example.test")
            self.assertTrue(session["csrfToken"])
            self.assertIsInstance(session["expiresAt"], int)
            self.assertGreater(session["expiresAt"], 0)

            second = ApiClient(port)
            status, _, body = second.setup(email="other@example.test", password=self.password)
            self.assertEqual(status, 409)
            self.assertEqual(body["error"]["code"], "setup_complete")

            status, _, body = client.request("POST", "/api/logout", {})
            self.assertEqual(status, 403)
            self.assertEqual(body["error"]["code"], "csrf_invalid")
            status, headers, body = client.request("POST", "/api/logout", {}, csrf=True)
            self.assertEqual(status, 200)
            self.assertIn("Max-Age=0", headers["Set-Cookie"])

    def test_session_and_csrf_survive_store_restart_without_raw_tokens_in_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            db_path = Path(temporary) / "restart.db"
            first = server.CareviewStore(db_path)
            _, session_token, csrf_token = first.setup(
                "Northstar Care",
                "Alex Admin",
                "admin@example.test",
                self.password,
            )
            del first
            restarted = server.CareviewStore(db_path)
            context = restarted.authenticate(session_token)
            self.assertTrue(restarted.verify_csrf(context, csrf_token))
            database_bytes = db_path.read_bytes()
            self.assertNotIn(session_token.encode("ascii"), database_bytes)
            self.assertNotIn(csrf_token.encode("ascii"), database_bytes)

    def test_setup_rejects_non_loopback_bootstrap(self):
        class NonLoopback:
            is_loopback = False

        with running_server() as port, patch.object(
            server.ipaddress, "ip_address", return_value=NonLoopback()
        ):
            status, _, body = ApiClient(port).setup(password=self.password)
            self.assertEqual(status, 403)
            self.assertEqual(body["error"]["code"], "setup_local_only")

    def test_admin_created_staff_login_and_admin_authorization(self):
        with running_server() as port:
            admin = ApiClient(port)
            self.assertEqual(admin.setup(password=self.password)[0], 201)

            status, _, body = admin.request(
                "POST",
                "/api/users",
                {"displayName": "Nora Nurse", "email": "nurse@example.test", "password": self.password},
            )
            self.assertEqual(status, 403)
            self.assertEqual(body["error"]["code"], "csrf_invalid")
            self.create_staff(admin)

            nonexistent = ApiClient(port).login("missing@example.test", "WrongPassword!234")
            incorrect = ApiClient(port).login("nurse@example.test", "WrongPassword!234")
            self.assertEqual(nonexistent[:1], incorrect[:1])
            self.assertEqual(nonexistent[2], incorrect[2])

            staff = ApiClient(port)
            status, _, body = staff.login("NURSE@example.test", self.password)
            self.assertEqual(status, 200, body)
            self.assertEqual(body["user"]["role"], "staff")
            status, _, body = staff.request("GET", "/api/users")
            self.assertEqual(status, 403)
            self.assertEqual(body["error"]["code"], "forbidden")
            status, _, body = staff.request(
                "POST",
                "/api/users",
                {"displayName": "No Access", "email": "no@example.test", "password": self.password},
                csrf=True,
            )
            self.assertEqual(status, 403)

    def test_two_users_share_workspace_patients_and_autosuggest(self):
        with running_server() as port:
            admin = ApiClient(port)
            self.assertEqual(admin.setup(password=self.password)[0], 201)
            self.create_staff(admin)
            patient = self.create_patient(admin, "Margaret Ellis", "Apartment 2")
            self.create_patient(admin, "John Rivera", "Home")

            staff = ApiClient(port)
            self.assertEqual(staff.login("nurse@example.test", self.password)[0], 200)
            status, _, body = staff.request("GET", "/api/patients?q=mar")
            self.assertEqual(status, 200, body)
            self.assertEqual([item["id"] for item in body["patients"]], [patient["id"]])
            self.assertEqual(body["patients"][0]["displayName"], "Margaret Ellis")

            status, _, body = staff.request("GET", f"/api/patients/{patient['id']}/scenes")
            self.assertEqual(status, 200, body)
            self.assertEqual(body, {"patient": patient, "scenes": []})
            staff_patient = self.create_patient(staff, "Avery Chen", "Residence")
            status, _, body = admin.request("GET", "/api/patients?q=Avery")
            self.assertEqual(status, 200)
            self.assertEqual(body["patients"][0]["id"], staff_patient["id"])

    def test_patient_analysis_is_authenticated_persisted_and_shared_without_media(self):
        captured = {}

        def fake_urlopen(upstream_request, timeout):
            captured["request"] = upstream_request
            captured["timeout"] = timeout
            return FakeResponse(responses_envelope(model_result()))

        with patch.dict(
            os.environ,
            {"OPENAI_API_KEY": "server-secret", "OPENAI_MODEL": "test-vision-model"},
            clear=True,
        ), patch.object(server, "urlopen", side_effect=fake_urlopen), running_server() as port:
            admin = ApiClient(port)
            self.assertEqual(admin.setup(password=self.password)[0], 201)
            self.create_staff(admin)
            patient = self.create_patient(admin)

            status, _, body = admin.request(
                "POST", f"/api/patients/{patient['id']}/analyze", video_payload()
            )
            self.assertEqual(status, 403)
            status, _, body = admin.request(
                "POST", f"/api/patients/{patient['id']}/analyze", video_payload(), csrf=True
            )
            self.assertEqual(status, 200, body)
            self.assertEqual(body["assessmentOutcome"], "findings_present")
            self.assertEqual(body["framesSubmitted"], 2)
            scene = body["scene"]
            self.assertEqual(scene["patientId"], patient["id"])
            self.assertEqual(scene["createdBy"]["displayName"], "Alex Admin")
            self.assertTrue(scene["createdAt"])
            persisted_finding = scene["assessment"]["findings"][0]
            self.assertTrue(persisted_finding["id"])
            self.assertEqual(persisted_finding["status"], "pending")
            self.assertEqual(persisted_finding["version"], 1)
            self.assertNotIn("data:image", json.dumps(scene))

            upstream_body = json.loads(captured["request"].data)
            self.assertEqual(captured["request"].headers["Authorization"], "Bearer server-secret")
            self.assertFalse(upstream_body["store"])
            self.assertTrue(upstream_body["text"]["format"]["strict"])

            staff = ApiClient(port)
            self.assertEqual(staff.login("nurse@example.test", self.password)[0], 200)
            status, _, history = staff.request("GET", f"/api/patients/{patient['id']}/scenes")
            self.assertEqual(status, 200, history)
            self.assertEqual(history["scenes"][0]["id"], scene["id"])
            self.assertNotIn("data:image", json.dumps(history))

            status, _, update = staff.request(
                "PATCH",
                f"/api/patients/{patient['id']}/findings/{persisted_finding['id']}",
                {"status": "confirmed", "note": "Verified in person.", "version": 1},
                csrf=True,
            )
            self.assertEqual(status, 200, update)
            self.assertEqual(update["finding"]["status"], "confirmed")
            self.assertEqual(update["finding"]["version"], 2)

            status, _, conflict = admin.request(
                "PATCH",
                f"/api/patients/{patient['id']}/findings/{persisted_finding['id']}",
                {"status": "dismissed", "note": "Stale edit", "version": 1},
                csrf=True,
            )
            self.assertEqual(status, 409, conflict)
            self.assertEqual(conflict["error"]["currentFinding"]["version"], 2)

    def test_missing_key_and_content_type_fail_safely_after_authorization(self):
        with patch.dict(os.environ, {}, clear=True), running_server() as port:
            client = ApiClient(port)
            self.assertEqual(client.setup(password=self.password)[0], 201)
            patient = self.create_patient(client)
            status, _, body = client.request(
                "POST", f"/api/patients/{patient['id']}/analyze", image_payload(), csrf=True
            )
            self.assertEqual(status, 503)
            self.assertEqual(body["error"]["code"], "analysis_not_configured")
            self.assertNotIn("OPENAI_API_KEY", json.dumps(body))

            status, _, body = client.request(
                "POST",
                f"/api/patients/{patient['id']}/analyze",
                image_payload(),
                csrf=True,
                headers={"Content-Type": "text/plain"},
            )
            self.assertEqual(status, 415)
            self.assertEqual(body["error"]["code"], "unsupported_media_type")

    def test_refusal_incomplete_and_upstream_errors_remain_safe(self):
        refusal = {
            "status": "completed",
            "output": [{"content": [{"type": "refusal", "refusal": "private details"}]}],
        }
        incomplete = {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}
        validated = server.validate_analysis_payload(image_payload())
        with patch.object(server, "urlopen", return_value=FakeResponse(refusal)):
            refused = server.analyze_scene(validated, "secret")
        with patch.object(server, "urlopen", return_value=FakeResponse(incomplete)):
            unfinished = server.analyze_scene(validated, "secret")
        self.assertEqual(refused["assessmentOutcome"], "refused")
        self.assertEqual(unfinished["assessmentOutcome"], "incomplete")
        self.assertNotIn("private details", json.dumps(refused))

        cases = (
            (socket.timeout("secret timeout detail"), TimeoutError),
            (server.URLError("private upstream detail"), server.UpstreamResponseError),
        )
        for failure, expected in cases:
            with self.subTest(failure=type(failure).__name__), patch.object(
                server, "urlopen", side_effect=failure
            ):
                with self.assertRaises(expected):
                    server.analyze_scene(validated, "secret")


if __name__ == "__main__":
    unittest.main()
