import base64
import http.client
import json
import os
import socket
import sys
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
    httpd = server.create_server("127.0.0.1", 0, ROOT)
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
    def test_health_and_static_security_headers(self):
        with running_server() as port:
            status, headers, body = request(port, "GET", "/api/health")
            self.assertEqual(status, 200)
            health = json.loads(body)
            self.assertEqual(health["status"], "ok")
            self.assertIsInstance(health["aiConfigured"], bool)
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
            self.assertEqual(headers["Referrer-Policy"], "no-referrer")

            status, headers, body = request(port, "GET", "/")
            self.assertEqual(status, 200)
            self.assertIn(b"Careview", body)
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")

    def test_static_allowlist_blocks_private_project_files(self):
        with running_server() as port:
            for path in (
                "/server.py",
                "/.gitignore",
                "/tests/test_server.py",
                "/scripts/generate_icons.py",
                "/__pycache__/server.pyc",
                "/../server.py",
            ):
                status, _, _ = request(port, "GET", path)
                self.assertEqual(status, 404, path)

    def test_missing_api_key_returns_503_without_reflection(self):
        with patch.dict(os.environ, {}, clear=True), running_server() as port:
            status, headers, body = request(port, "POST", "/api/analyze", image_payload())
        parsed = json.loads(body)
        self.assertEqual(status, 503)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(parsed["error"]["code"], "analysis_not_configured")
        self.assertNotIn("OPENAI_API_KEY", body.decode("utf-8"))

    def test_completed_analysis_uses_safe_responses_request(self):
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
            status, _, body = request(port, "POST", "/api/analyze", video_payload())

        parsed = json.loads(body)
        upstream_body = json.loads(captured["request"].data)
        self.assertEqual(status, 200)
        self.assertEqual(parsed["assessmentOutcome"], "findings_present")
        self.assertEqual(parsed["assessment_status"], "assessed")
        self.assertEqual(parsed["framesSubmitted"], 2)
        self.assertNotIn("framesAnalyzed", parsed)
        self.assertNotIn("frames_analyzed", parsed)
        self.assertEqual(parsed["analysisCoverage"]["timestampsMs"], [0, 2500])
        self.assertNotIn("framesReviewed", parsed["analysisCoverage"])
        self.assertNotIn("server-secret", body.decode("utf-8"))
        self.assertEqual(captured["request"].full_url, server.OPENAI_RESPONSES_URL)
        self.assertEqual(captured["request"].headers["Authorization"], "Bearer server-secret")
        self.assertFalse(upstream_body["store"])
        self.assertEqual(upstream_body["reasoning"], {"effort": "low"})
        self.assertTrue(upstream_body["text"]["format"]["strict"])
        self.assertEqual(
            [item["type"] for item in upstream_body["input"][0]["content"]],
            ["input_text", "input_image", "input_image"],
        )
        self.assertTrue(all(
            item.get("detail") == "high"
            for item in upstream_body["input"][0]["content"]
            if item["type"] == "input_image"
        ))

    def test_refusal_and_incomplete_are_safe_unable_results(self):
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
        self.assertEqual(refused["findings"], [])

    def test_timeout_and_upstream_failure_do_not_leak_details(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "top-secret"}, clear=True), patch.object(
            server, "urlopen", side_effect=socket.timeout("secret timeout detail")
        ), running_server() as port:
            status, _, body = request(port, "POST", "/api/analyze", image_payload())
        self.assertEqual(status, 504)
        self.assertEqual(json.loads(body)["error"]["code"], "analysis_timeout")
        self.assertNotIn("secret", body.decode("utf-8"))

        with patch.dict(os.environ, {"OPENAI_API_KEY": "top-secret"}, clear=True), patch.object(
            server, "urlopen", side_effect=server.URLError("private upstream detail")
        ), running_server() as port:
            status, _, body = request(port, "POST", "/api/analyze", image_payload())
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body)["error"]["code"], "analysis_unavailable")
        self.assertNotIn("private", body.decode("utf-8"))

    def test_upstream_rate_limit_and_credentials_map_to_safe_statuses(self):
        cases = (
            (429, 429, "analysis_rate_limited"),
            (401, 503, "analysis_not_configured"),
            (403, 503, "analysis_not_configured"),
        )
        for upstream_status, expected_status, expected_code in cases:
            upstream_error = server.HTTPError(
                server.OPENAI_RESPONSES_URL,
                upstream_status,
                "private upstream detail",
                hdrs=None,
                fp=None,
            )
            with self.subTest(upstream_status=upstream_status), patch.dict(
                os.environ, {"OPENAI_API_KEY": "top-secret"}, clear=True
            ), patch.object(server, "urlopen", side_effect=upstream_error), running_server() as port:
                status, _, body = request(port, "POST", "/api/analyze", image_payload())
            self.assertEqual(status, expected_status)
            self.assertEqual(json.loads(body)["error"]["code"], expected_code)
            self.assertNotIn("private", body.decode("utf-8"))

    def test_rejects_wrong_content_type_before_analysis(self):
        with running_server() as port:
            status, _, body = request(
                port,
                "POST",
                "/api/analyze",
                image_payload(),
                {"Content-Type": "text/plain"},
            )
        self.assertEqual(status, 415)
        self.assertEqual(json.loads(body)["error"]["code"], "unsupported_media_type")


if __name__ == "__main__":
    unittest.main()
