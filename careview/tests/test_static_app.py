import json
import re
import unittest
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class AppHTMLParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.scripts = []
        self.links = []
        self.meta = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if "id" in values:
            self.ids.add(values["id"])
        if tag == "script":
            self.scripts.append(values)
        elif tag == "link":
            self.links.append(values)
        elif tag == "meta":
            self.meta.append(values)


class StaticAppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "index.html").read_text(encoding="utf-8")
        cls.css = (ROOT / "styles.css").read_text(encoding="utf-8")
        cls.js = (ROOT / "app.js").read_text(encoding="utf-8")
        cls.worker = (ROOT / "sw.js").read_text(encoding="utf-8")
        cls.readme = (ROOT / "README.md").read_text(encoding="utf-8")
        cls.manifest = json.loads((ROOT / "manifest.webmanifest").read_text(encoding="utf-8"))
        cls.parser = AppHTMLParser()
        cls.parser.feed(cls.html)

    def test_required_static_files_exist(self):
        for name in ("index.html", "styles.css", "app.js", "manifest.webmanifest", "sw.js", "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "README.md"):
            self.assertTrue((ROOT / name).is_file(), name)

    def test_app_shell_has_expected_mount_points(self):
        self.assertTrue({"app", "toast", "bottom-sheet", "sheet-backdrop"}.issubset(self.parser.ids))
        self.assertTrue(any(script.get("src") == "app.js" for script in self.parser.scripts))
        self.assertTrue(any(link.get("rel") == "manifest" for link in self.parser.links))

    def test_mobile_and_theme_metadata_are_present(self):
        viewport = next(meta for meta in self.parser.meta if meta.get("name") == "viewport")
        self.assertIn("width=device-width", viewport["content"])
        self.assertTrue(any(meta.get("name") == "theme-color" for meta in self.parser.meta))

    def test_apple_mobile_metadata_and_touch_icon_are_present(self):
        apple_capable = next(
            meta for meta in self.parser.meta
            if meta.get("name") == "apple-mobile-web-app-capable"
        )
        self.assertEqual(apple_capable.get("content", "").lower(), "yes")
        self.assertTrue(any(
            meta.get("name") == "apple-mobile-web-app-status-bar-style"
            for meta in self.parser.meta
        ))
        self.assertTrue(any(
            "apple-touch-icon" in link.get("rel", "").split()
            and link.get("href") == "apple-touch-icon.png"
            for link in self.parser.links
        ))

    def test_manifest_is_installable_app_shell(self):
        self.assertEqual(self.manifest["display"], "standalone")
        self.assertEqual(self.manifest["start_url"], "./")
        self.assertTrue(self.manifest.get("id"))
        self.assertEqual(self.manifest.get("lang"), "en")
        self.assertEqual(self.manifest.get("dir"), "ltr")
        self.assertNotIn("orientation", self.manifest)
        self.assertTrue(self.manifest["icons"])
        sizes = {icon["sizes"] for icon in self.manifest["icons"]}
        self.assertTrue({"192x192", "512x512", "any"}.issubset(sizes))

    def test_ios_install_guidance_hooks_exist(self):
        for hook in (
            "show-ios-install",
            "isIosDevice",
            "navigator.standalone",
            "display-mode: standalone",
        ):
            self.assertIn(hook, self.js)
        normalized = self.js.lower()
        for phrase in ("add to home screen", "open as web app"):
            self.assertIn(phrase, normalized)

    def test_service_worker_caches_every_shell_asset(self):
        for asset in ("index.html", "styles.css", "app.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"):
            self.assertIn(asset, self.worker)
        self.assertIn('requestUrl.origin !== self.location.origin', self.worker)
        self.assertIn('event.request.mode === "navigate"', self.worker)
        self.assertIn("APP_SHELL_URL_SET", self.worker)
        self.assertIn('"serviceWorker" in navigator && window.isSecureContext', self.js)

    def test_guided_flow_hooks_exist(self):
        for action in ("start-scan", "select-zone", "use-demo", "analyze", "open-finding", "save-review", "review-pending"):
            self.assertIn(action, self.js)
        self.assertEqual(len(re.findall(r"name: \"(?:Kitchen|Fridge & freezer|Medication area|Living space)\"", self.js)), 4)

    def test_safety_language_is_explicit(self):
        normalized = self.js.lower()
        for phrase in ("does not diagnose", "does not prove", "do not change a dose", "human review"):
            self.assertIn(phrase, normalized)
        self.assertIn("not running a real vision model", normalized)

    def test_responsive_and_reduced_motion_styles_exist(self):
        self.assertIn("@media (max-width: 350px)", self.css)
        self.assertIn("prefers-reduced-motion", self.css)
        self.assertIn("env(safe-area-inset-bottom", self.css)

    def test_review_and_privacy_boundaries_are_implemented(self):
        self.assertIn("reviewDraftStatus", self.js)
        self.assertIn("appShell.inert = true", self.js)
        self.assertIn('action === "clear-local"', self.js)
        self.assertIn("clearMediaPreview()", self.js)
        self.assertIn("object-fit: contain", self.css)
        for misleading_claim in ("Framing looks good", "Privacy filter on", "Good light · Full area", "Avg. visual confidence"):
            self.assertNotIn(misleading_claim, self.js)

    def test_image_and_video_selection_are_supported(self):
        self.assertIn('accept="image/*,video/*"', self.js)
        self.assertIn('file.type.startsWith("image/")', self.js)
        self.assertIn('file.type.startsWith("video/")', self.js)
        self.assertIn("video.onloadedmetadata", self.js)
        self.assertIn("video.videoWidth", self.js)
        self.assertIn("video.videoHeight", self.js)
        self.assertIn("mediaLoadToken", self.js)
        self.assertIn("pendingMediaUrl", self.js)
        self.assertIn("cancelPendingMediaLoad()", self.js)
        self.assertIn("100 * 1024 * 1024", self.js)
        self.assertIn("duration > 30", self.js)
        self.assertIn("Math.max(width, height) > 3840", self.js)

    def test_direct_camera_capture_inputs_are_available(self):
        capture_inputs = re.findall(
            r'<input\b[^>]*\bcapture=["\']environment["\'][^>]*>',
            self.js,
            flags=re.IGNORECASE,
        )
        self.assertGreaterEqual(len(capture_inputs), 2)
        self.assertTrue(any(re.search(r'accept=["\'][^"\']*image/\*', tag, re.I) for tag in capture_inputs))
        self.assertTrue(any(re.search(r'accept=["\'][^"\']*video/\*', tag, re.I) for tag in capture_inputs))

    def test_ios_touch_and_input_zoom_safeguards_exist(self):
        self.assertIn("touch-action: manipulation", self.css)
        self.assertIn("-webkit-tap-highlight-color", self.css)
        self.assertRegex(self.css, r"font-size:\s*(?:16px|max\(16px)")

    def test_video_preview_is_user_controlled_and_not_cached(self):
        preview = re.search(r'return `<video class="capture-preview"[^;]+;', self.js)
        self.assertIsNotNone(preview)
        preview_markup = preview.group(0)
        for attribute in ("controls", "muted", "playsinline", 'preload="metadata"'):
            self.assertIn(attribute, preview_markup)
        self.assertNotIn("autoplay", preview_markup)
        self.assertNotIn("mediaPreview", self.worker)
        self.assertIn("capture-frame.video-media .capture-overlay", self.css)
        self.assertIn('window.addEventListener("pagehide"', self.js)

    def test_demo_does_not_claim_media_was_inspected(self):
        normalized = self.js.lower()
        self.assertIn("no video frames are being inspected", normalized)
        self.assertIn("were not inferred from your selected image or video", normalized)
        self.assertIn("one image or one video counts as one scene check", self.readme.lower())
        for false_claim in ("checking image quality", "comparing visible items with baseline"):
            self.assertNotIn(false_claim, normalized)
        self.assertNotRegex(self.js, r"\$\{finding\.confidence\}% confidence")
        self.assertIn("Confidence not calculated", self.js)

    def test_ai_client_uses_server_proxy_and_prepares_only_still_images(self):
        for hook in (
            '/api/patients/${encodeURIComponent(patientId)}/analyze',
            'credentials: "same-origin"',
            'cache: "no-store"',
            "prepareImageForAnalysis",
            "prepareVideoForAnalysis",
            "MAX_VIDEO_FRAMES = 6",
            "MAX_ANALYSIS_EDGE = 1280",
            'canvas.toDataURL("image/jpeg"',
        ):
            self.assertIn(hook, self.js)
        self.assertNotIn("OPENAI_API_KEY", self.js)
        self.assertNotIn("api.openai.com", self.js)
        self.assertNotIn("/api/analyze", self.worker)

    def test_ai_upload_requires_fresh_consent_and_is_cancellable(self):
        for hook in (
            'id="analysis-consent"',
            "analysisConsentConfirmed",
            "analysisConsentConfirmed = false",
            "new AbortController()",
            "ANALYSIS_TIMEOUT_MS = 90_000",
            "cancelActiveAnalysis()",
            'data-action="cancel-analysis"',
            "cancelAnalysisAndReturn()",
        ):
            self.assertIn(hook, self.js)
        self.assertIn("confirm consent and the privacy review", self.js.lower())

    def test_ai_privacy_and_emergency_disclosures_are_in_the_flow(self):
        normalized = self.js.lower()
        for phrase in (
            "automated redaction is not active",
            "raw video and audio stay local",
            "shared workspace",
            "never in browser storage",
            "not emergency monitoring",
        ):
            self.assertIn(phrase, normalized)

    def test_model_controlled_finding_text_is_escaped_before_rendering(self):
        for expression in (
            "escapeHtml(finding.title)",
            "escapeHtml(finding.observed)",
            "escapeHtml(finding.meaning)",
            "escapeHtml(finding.action)",
            "escapeHtml(finding.limitation)",
        ):
            self.assertIn(expression, self.js)

    def test_evidence_timestamps_and_saved_review_modes_are_not_conflated(self):
        self.assertIn("formatEvidenceTimestamp", self.js)
        self.assertIn('data-action="seek-evidence"', self.js)
        self.assertIn("currentResultAggregate", self.js)
        self.assertIn("Multiple saved scene checks", self.js)
        self.assertIn('window.addEventListener("pageshow"', self.js)
        self.assertNotIn("service reported ${framesAnalyzed} analyzed", self.js)

    def test_real_mode_does_not_start_with_urgent_demo_cards(self):
        default_state = re.search(r"let state = \{(.+?)\n  \};", self.js, re.DOTALL)
        self.assertIsNotNone(default_state)
        self.assertIn("findings: []", default_state.group(0))
        self.assertIn("scans: []", default_state.group(0))
        self.assertNotIn("urgencyLabel", default_state.group(0))

    def test_authentication_setup_and_csrf_contracts_exist(self):
        for hook in (
            'apiFetch("/api/session")',
            '"/api/setup"',
            '"/api/login"',
            '"/api/logout"',
            'headers.set("X-CSRF-Token", session.csrfToken)',
            'credentials: "same-origin"',
            'data-form="${setup ? "setup" : "login"}"',
            "bootstrapSession()",
        ):
            self.assertIn(hook, self.js)
        self.assertIn('id="app-header" hidden', self.html)
        self.assertIn('id="primary-navigation"', self.html)
        self.assertIn('minlength="${setup ? 14 : 1}" maxlength="200"', self.js)
        self.assertRegex(self.js, r'id="staff-password"[^>]+minlength="14"[^>]+maxlength="200"')
        self.assertIn("uppercase, lowercase, a number, and a symbol", self.js)
        self.assertNotIn('minlength="8"', self.js)

    def test_failed_logout_preserves_the_active_local_session(self):
        sign_out = self.js[
            self.js.index("async function signOut()") : self.js.index("async function saveFindingReview()")
        ]
        self.assertIn('showToast("Sign-out failed. You are still signed in.")', sign_out)
        self.assertRegex(
            sign_out,
            re.compile(r"catch \(error\) \{.+?return;\s+\}.+?transitionToSignedOut\(\);", re.DOTALL),
        )
        self.assertNotIn("clearSensitiveClientState", sign_out)

    def test_visible_tab_always_revalidates_the_server_session(self):
        revalidation = self.js[
            self.js.index("function revalidateSession()") : self.js.index("function renderAuthScreen")
        ]
        self.assertIn('apiFetch("/api/session")', revalidation)
        self.assertIn("payload.authenticated !== true", revalidation)
        self.assertIn("transitionToSignedOut", revalidation)
        self.assertIn("loadPatientScenes(selectedPatient, { quiet: true })", revalidation)
        self.assertIn(
            'if (document.visibilityState === "visible") revalidateSession();', self.js
        )

    def test_server_session_expiry_has_one_replaceable_sign_out_timer(self):
        scheduler = self.js[
            self.js.index("function clearSessionExpiryTimer()") : self.js.index("function transitionToSignedOut")
        ]
        self.assertIn("clearTimeout(sessionExpiryTimer)", scheduler)
        self.assertIn("Number(expiresAt)", scheduler)
        self.assertIn("Date.now()", scheduler)
        self.assertIn("setTimeout(() => transitionToSignedOut(), delay)", scheduler)
        self.assertIn("clearSessionExpiryTimer();\n    clearSensitiveClientState();", self.js)
        self.assertGreaterEqual(self.js.count("scheduleSessionExpiry(session.expiresAt)"), 2)
        self.assertIn("expiresAt: Number.isFinite(Number(payload.expiresAt))", self.js)

    def test_patient_picker_is_accessible_and_patient_scoped(self):
        for hook in (
            'role="combobox"',
            'aria-autocomplete="list"',
            'role="listbox"',
            'aria-activedescendant',
            'event.key === "ArrowDown"',
            'event.key === "ArrowUp"',
            'event.key === "Escape"',
            'data-form="add-patient"',
            'apiFetch("/api/patients"',
            '/api/patients/${encodeURIComponent(requestedId)}/scenes',
            "analysisPatientId",
        ):
            self.assertIn(hook, self.js)

    def test_shared_review_and_admin_staff_contracts_exist(self):
        for hook in (
            '/findings/${encodeURIComponent(finding.id)}',
            'method: "PATCH"',
            "version:",
            "error.status === 409",
            'apiFetch("/api/users")',
            'data-form="add-user"',
            'String(user?.role || "").toLowerCase() === "admin"',
        ):
            self.assertIn(hook, self.js)

    def test_patient_data_and_tokens_are_not_persisted_in_browser_storage(self):
        save_preferences = re.search(
            r"function savePreferences\(\) \{(.+?)\n  \}", self.js, re.DOTALL
        )
        self.assertIsNotNone(save_preferences)
        saved = save_preferences.group(0)
        self.assertIn("settings:", saved)
        for forbidden in ("selectedPatientId", "findings:", "scans:", "csrfToken", "patientDirectory", "selectedPatient:"):
            self.assertNotIn(forbidden, saved)
        self.assertNotIn("selectedPatientId", self.js)
        self.assertNotIn("sessionStorage", self.js)
        self.assertNotIn('localStorage.setItem(LEGACY_STORAGE_KEY', self.js)
        self.assertEqual(set(re.findall(r"localStorage\.setItem\(([^,]+),", self.js)), {"PREFERENCES_KEY"})

    def test_no_hard_coded_caregiver_or_patient_identity_remains(self):
        for identity in ("Sarah", "Margaret Ellis", "Margaret's"):
            self.assertNotIn(identity, self.html)
            self.assertNotIn(identity, self.js)

    def test_service_worker_never_intercepts_api_requests(self):
        self.assertIn('requestUrl.pathname.startsWith("/api/")', self.worker)

    def test_readme_documents_server_side_ai_setup_and_prototype_limits(self):
        normalized = self.readme.lower()
        for phrase in (
            "python careview\\server.py",
            "openai_api_key",
            "store: false",
            "up to six timestamped jpeg frames",
            "not a production healthcare-data system",
        ):
            self.assertIn(phrase, normalized)


if __name__ == "__main__":
    unittest.main()
