(function () {
  "use strict";

  const PREFERENCES_KEY = "careview-ui-v2";
  const LEGACY_STORAGE_KEY = "careview-prototype-v1";
  const app = document.querySelector("#app");
  const nav = document.querySelector(".bottom-nav");
  const appHeader = document.querySelector("#app-header");
  const userMenuButton = document.querySelector("#user-menu-button");
  const userInitials = document.querySelector("#user-initials");
  const sheet = document.querySelector("#bottom-sheet");
  const sheetBackdrop = document.querySelector("#sheet-backdrop");
  const toast = document.querySelector("#toast");
  const appShell = document.querySelector(".app-shell");

  const zones = {
    kitchen: {
      name: "Kitchen",
      description: "Counters, sink & walkways",
      prompt: "Include the counter, sink, floor, and main walking path.",
      icon: "kitchen",
    },
    fridge: {
      name: "Fridge & freezer",
      description: "Food stock & storage",
      prompt: "Open the doors and include the shelves and contents, while keeping names and identifying labels out of view.",
      icon: "fridge",
    },
    medication: {
      name: "Medication area",
      description: "Organizer & storage",
      prompt: "Include the organizer and nearby surfaces. Keep names private.",
      icon: "medication",
    },
    living: {
      name: "Living space",
      description: "Clutter & trip hazards",
      prompt: "Include the floor, common path, table, and seating area.",
      icon: "living",
    },
  };

  const defaultPreferences = {
    settings: {
      redact: true,
      retain: false,
      caregiverUpdates: true,
      iosInstallDismissed: false,
    },
  };

  const preferences = loadPreferences();
  let state = {
    settings: preferences.settings,
    findings: [],
    scans: [],
  };
  let session = {
    status: "loading",
    authenticated: false,
    setupRequired: false,
    user: null,
    csrfToken: "",
    expiresAt: null,
  };
  let currentRoute = "patients";
  let selectedPatient = null;
  let patientDirectory = [];
  let patientSuggestions = [];
  let patientQuery = "";
  let patientSearchOpen = false;
  let patientActiveIndex = -1;
  let patientDirectoryLoading = false;
  let patientSearchLoading = false;
  let patientSceneLoading = false;
  let patientError = "";
  let patientSearchController = null;
  let patientSearchTimer = null;
  let authBusy = false;
  let authError = "";
  let authDraft = { workspaceName: "", displayName: "", email: "" };
  let patientMutationBusy = false;
  let patientDraft = { displayName: "", careLocation: "" };
  let staffUsers = [];
  let staffLoading = false;
  let staffError = "";
  let staffDraft = { displayName: "", email: "" };
  let scanStep = 1;
  let selectedZone = null;
  let mediaPreview = "";
  let mediaMeta = null;
  let mediaType = "";
  let selectedMediaFile = null;
  let isDemoMedia = false;
  let mediaLoading = false;
  let mediaError = "";
  let mediaLoadToken = 0;
  let pendingMediaUrl = "";
  let pendingMediaLoader = null;
  let currentFindings = [];
  let activeFilter = "All";
  let activeFindingId = null;
  let reviewDraftStatus = "pending";
  let sheetReturnFocus = null;
  let analysisTimer = null;
  let analysisController = null;
  let analysisPatientId = "";
  let analysisRunToken = 0;
  let analysisProgressMessage = "";
  let currentAnalysisSummary = null;
  let currentResultAggregate = false;
  let analysisConsentConfirmed = false;
  let toastTimer = null;
  let sessionRevalidationPromise = null;
  let sessionExpiryTimer = null;

  const ANALYSIS_TIMEOUT_MS = 90_000;
  const MAX_VIDEO_FRAMES = 6;
  const MAX_ANALYSIS_EDGE = 1280;
  const JPEG_QUALITY = 0.78;

  function loadPreferences() {
    let saved = null;
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    try {
      saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY));
    } catch (_error) {
      saved = null;
    }
    const loaded = {
      settings: {
        redact: typeof saved?.settings?.redact === "boolean" ? saved.settings.redact : defaultPreferences.settings.redact,
        retain: typeof saved?.settings?.retain === "boolean" ? saved.settings.retain : defaultPreferences.settings.retain,
        caregiverUpdates: typeof saved?.settings?.caregiverUpdates === "boolean" ? saved.settings.caregiverUpdates : defaultPreferences.settings.caregiverUpdates,
        iosInstallDismissed: typeof saved?.settings?.iosInstallDismissed === "boolean" ? saved.settings.iosInstallDismissed : defaultPreferences.settings.iosInstallDismissed,
      },
    };
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(loaded));
    return loaded;
  }

  function savePreferences() {
    const safePreferences = {
      settings: { ...state.settings },
    };
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(safePreferences));
  }

  function resetPatientData() {
    state.findings = [];
    state.scans = [];
    selectedPatient = null;
    currentFindings = [];
    currentAnalysisSummary = null;
    currentResultAggregate = false;
    activeFindingId = null;
  }

  function clearSensitiveClientState() {
    cancelActiveAnalysis();
    clearMediaPreview();
    clearTimeout(patientSearchTimer);
    if (patientSearchController) patientSearchController.abort();
    patientSearchController = null;
    resetPatientData();
    patientDirectory = [];
    patientSuggestions = [];
    patientQuery = "";
    patientSearchOpen = false;
    patientActiveIndex = -1;
    staffUsers = [];
    staffError = "";
    patientDraft = { displayName: "", careLocation: "" };
    staffDraft = { displayName: "", email: "" };
  }

  function clearSessionExpiryTimer() {
    if (sessionExpiryTimer !== null) clearTimeout(sessionExpiryTimer);
    sessionExpiryTimer = null;
  }

  function scheduleSessionExpiry(expiresAt) {
    clearSessionExpiryTimer();
    const epochSeconds = Number(expiresAt);
    if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return;
    const delay = Math.max(0, Math.min(epochSeconds * 1000 - Date.now(), 2_147_483_647));
    sessionExpiryTimer = setTimeout(() => transitionToSignedOut(), delay);
  }

  function transitionToSignedOut({ setupRequired = false } = {}) {
    clearSessionExpiryTimer();
    clearSensitiveClientState();
    authDraft = { workspaceName: "", displayName: "", email: "" };
    session = { status: "ready", authenticated: false, setupRequired, user: null, csrfToken: "", expiresAt: null };
    currentRoute = "patients";
    window.history.replaceState({ route: "patients", scanStep: 0 }, "");
    render();
  }

  function icon(name) {
    const icons = {
      arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
      back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
      camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h4l1.5-2h5l1.5 2h4v11H4Z"/><circle cx="12" cy="13" r="3.5"/></svg>',
      shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s8-3.6 8-10V5.7L12 3 4 5.7V11c0 6.4 8 10 8 10Z"/><path d="M8.8 12.1 11 14.3l4.5-4.8"/></svg>',
      info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg>',
      check: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.4 2.5 4.8-5"/></svg>',
      sparkle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.3 4.4L18 9l-4.7 1.6L12 15l-1.4-4.4L6 9l4.6-1.6ZM18.5 15l.7 2.2 2.3.8-2.3.8-.7 2.2-.7-2.2-2.3-.8 2.3-.8Z"/></svg>',
      food: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v6a3 3 0 0 0 3 3V4m-3 4h3m5-4v16m0-16c3 1.6 3.8 5.5 0 8"/></svg>',
      medication: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.2 4.2a4 4 0 0 1 5.6 0l6 6a4 4 0 0 1-5.6 5.6l-6-6a4 4 0 0 1 0-5.6Z"/><path d="m11.2 7.2-3 3m5-1 3 3"/></svg>',
      cleanliness: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 3 7 7-3 3-7-7Zm-4.5 4.5L3 14l7 7 6.5-6.5"/><path d="m6 13 5 5m-2.5-7.5 5 5"/></svg>',
      kitchen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11h18v9H3Zm2-7h14v7H5Zm3 10v3m8-3v3M9 7h.01m6 0h.01"/></svg>',
      fridge: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2"/><path d="M6 10h12M9 6v2m0 5v3"/></svg>',
      living: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v3"/><path d="M4 10a2 2 0 0 0-2 2v6h20v-6a2 2 0 0 0-4 0v2H6v-2a2 2 0 0 0-2-2Zm1 8v3m14-3v3"/></svg>',
      trend: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18 9 12l4 3 7-9"/><path d="M15 6h5v5"/></svg>',
      lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/></svg>',
      users: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2m1-12a3 3 0 0 1 0 6m2-1a5 5 0 0 1 3 5v2"/></svg>',
      download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 20h16"/></svg>',
      bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8Zm-8 11h4"/></svg>',
      image: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 17 5-4 3 2 3-3 5 5"/></svg>',
      video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3Z"/></svg>',
      share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4"/><path d="M6 11H4v10h16V11h-2"/></svg>',
      trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-10-3h4l1 3M7 7l1 14h8l1-14M10 11v6m4-6v6"/></svg>',
      refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8a7 7 0 0 1 11.6-1.5L20 9M4 15l2.3 2.5A7 7 0 0 0 18 16"/></svg>',
      search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>',
      plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
      logout: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H5v16h5m4-4 4-4-4-4m4 4H9"/></svg>',
      user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    };
    return icons[name] || icons.info;
  }

  function isIosDevice() {
    const userAgent = navigator.userAgent || "";
    return /iPad|iPhone|iPod/.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function isStandaloneMode() {
    return window.matchMedia?.("(display-mode: standalone)")?.matches || navigator.standalone === true;
  }

  function displayName(record, fallback = "Careview user") {
    if (typeof record === "string" && record.trim()) return record.trim();
    const value = record?.displayName ?? record?.display_name ?? record?.name;
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  function initialsFor(record) {
    return displayName(record, "CV")
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] || "")
      .join("")
      .toUpperCase() || "CV";
  }

  function isAdminUser(user = session.user) {
    return Boolean(user?.isAdmin || user?.is_admin || String(user?.role || "").toLowerCase() === "admin");
  }

  async function apiFetch(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    if (options.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (!["GET", "HEAD"].includes(method) && session.csrfToken) headers.set("X-CSRF-Token", session.csrfToken);
    const response = await fetch(path, {
      ...options,
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (_error) {
      payload = null;
    }
    if (response.ok && typeof payload?.csrfToken === "string") session.csrfToken = payload.csrfToken;
    if (!response.ok) {
      if (response.status === 401) {
        transitionToSignedOut();
      }
      const error = new Error(payload?.error?.message || payload?.message || "Careview could not complete that request.");
      error.status = response.status;
      error.code = payload?.error?.code || payload?.code || "request_failed";
      error.payload = payload;
      throw error;
    }
    return payload || {};
  }

  function normalizeFinding(rawFinding, scene) {
    const urgencyValue = String(rawFinding?.urgency || "soon").toLowerCase().replaceAll(" ", "_");
    const urgency = ["now", "soon", "monitor"].includes(urgencyValue) ? urgencyValue : urgencyValue === "check_now" ? "now" : "soon";
    const status = ["pending", "confirmed", "resolved", "dismissed"].includes(rawFinding?.status) ? rawFinding.status : "pending";
    const frames = rawFinding?.evidenceFrameNumbers ?? rawFinding?.evidence_frame_numbers;
    const evidenceSeconds = rawFinding?.evidenceTimestamps ?? rawFinding?.evidence_timestamps_seconds;
    const evidenceMilliseconds = rawFinding?.evidenceTimestampsMs ?? rawFinding?.evidence_timestamps_ms;
    const evidenceTimestamps = Array.isArray(evidenceSeconds)
      ? evidenceSeconds
      : Array.isArray(evidenceMilliseconds) ? evidenceMilliseconds.filter(Number.isFinite).map((value) => value / 1000) : [];
    return {
      id: String(rawFinding?.id || `${scene.id}-finding-${Math.random().toString(36).slice(2)}`),
      scanId: String(scene.id || ""),
      patientId: String(selectedPatient?.id || ""),
      category: String(rawFinding?.category || "Cleanliness"),
      title: String(rawFinding?.title || "Observation"),
      observed: String(rawFinding?.observed ?? rawFinding?.visibleObservation ?? rawFinding?.visible_observation ?? "Review this visible condition in person."),
      meaning: String(rawFinding?.meaning ?? rawFinding?.whyItMayMatter ?? rawFinding?.why_it_may_matter ?? "This visible condition may warrant review."),
      action: String(rawFinding?.action ?? rawFinding?.caregiverCheck ?? rawFinding?.suggestedCaregiverCheck ?? rawFinding?.suggested_caregiver_check ?? "Check this condition in person."),
      urgency,
      urgencyLabel: String(rawFinding?.urgencyLabel ?? rawFinding?.urgency_label ?? (urgency === "now" ? "Check now" : urgency === "monitor" ? "Monitor" : "Review soon")),
      confidence: null,
      limitation: String(rawFinding?.limitation ?? rawFinding?.uncertainty ?? "The scene may be incomplete or unclear."),
      status,
      note: typeof rawFinding?.note === "string" ? rawFinding.note : "",
      version: Number.isInteger(rawFinding?.version) ? rawFinding.version : 0,
      updatedAt: rawFinding?.updatedAt ?? rawFinding?.updated_at ?? null,
      reviewedBy: rawFinding?.reviewedBy ?? rawFinding?.reviewed_by ?? null,
      zone: scene.zoneLabel,
      timestamp: scene.timestamp,
      mediaType: scene.mediaType,
      durationSeconds: scene.durationSeconds,
      framesSent: Number.isInteger(scene.framesSent) ? scene.framesSent : 0,
      frameTimestamps: [...scene.frameTimestamps],
      evidenceFrameNumbers: Array.isArray(frames) ? frames.filter(Number.isInteger).slice(0, MAX_VIDEO_FRAMES) : [],
      evidenceTimestamps: Array.isArray(evidenceTimestamps) ? evidenceTimestamps.filter(Number.isFinite).slice(0, MAX_VIDEO_FRAMES) : [],
      source: scene.source,
      assessmentStatus: scene.assessmentStatus,
      assessmentOutcome: scene.assessmentOutcome,
      model: scene.model,
      demoOutput: false,
    };
  }

  function normalizeServerScene(rawScene) {
    const rawAssessment = rawScene?.assessment && typeof rawScene.assessment === "object" ? rawScene.assessment : {};
    const rawFindings = Array.isArray(rawAssessment.findings)
      ? rawAssessment.findings
      : Array.isArray(rawScene?.findings) ? rawScene.findings : [];
    const zoneKey = String(rawScene?.zone || "");
    const timestamp = rawScene?.createdAt ?? rawScene?.created_at ?? rawScene?.timestamp ?? null;
    const coverage = rawAssessment?.analysisCoverage ?? rawAssessment?.analysis_coverage ?? {};
    const rawFrameSeconds = rawAssessment?.frameTimestamps ?? rawAssessment?.frame_timestamps ?? rawScene?.frameTimestamps;
    const rawFrameMilliseconds = coverage?.timestampsMs ?? coverage?.timestamps_ms;
    const frameTimestamps = Array.isArray(rawFrameSeconds)
      ? rawFrameSeconds
      : Array.isArray(rawFrameMilliseconds) ? rawFrameMilliseconds.filter(Number.isFinite).map((value) => value / 1000) : [];
    const scene = {
      id: String(rawScene?.id || ""),
      zone: zoneKey,
      zoneLabel: String((rawScene?.zoneLabel ?? rawScene?.zone_label ?? zones[zoneKey]?.name ?? zoneKey) || "Scene"),
      timestamp,
      createdAt: timestamp,
      createdBy: rawScene?.createdBy ?? rawScene?.created_by ?? null,
      mediaType: String(rawScene?.mediaType ?? rawScene?.media_type ?? "image"),
      durationSeconds: rawScene?.durationSeconds ?? rawScene?.duration_seconds ?? null,
      source: "ai",
      framesSent: Number.isInteger(rawAssessment?.framesSent ?? rawAssessment?.frames_sent ?? rawAssessment?.framesSubmitted ?? rawAssessment?.frames_submitted ?? rawScene?.framesSubmitted ?? rawScene?.frames_submitted)
        ? rawAssessment.framesSent ?? rawAssessment.frames_sent ?? rawAssessment.framesSubmitted ?? rawAssessment.frames_submitted ?? rawScene.framesSubmitted ?? rawScene.frames_submitted
        : Array.isArray(frameTimestamps) ? frameTimestamps.length : 0,
      frameTimestamps: Array.isArray(frameTimestamps) ? frameTimestamps.filter(Number.isFinite).slice(0, MAX_VIDEO_FRAMES) : [],
      assessmentStatus: rawAssessment?.assessmentStatus ?? rawAssessment?.assessment_status ?? rawAssessment?.status ?? "assessed",
      assessmentOutcome: rawAssessment?.assessmentOutcome ?? rawAssessment?.assessment_outcome ?? null,
      assessmentNote: rawAssessment?.assessmentNote ?? rawAssessment?.assessment_note ?? null,
      unableToAssess: Boolean(rawAssessment?.unableToAssess ?? rawAssessment?.unable_to_assess),
      model: rawAssessment?.model ?? null,
      demoOutput: false,
    };
    scene.findings = rawFindings.map((finding) => normalizeFinding(finding, scene));
    scene.count = scene.findings.length;
    scene.type = scene.unableToAssess ? "unable" : scene.count ? "review" : "clear";
    return scene;
  }

  function applyPatientScenes(rawScenes) {
    const scenes = (Array.isArray(rawScenes) ? rawScenes : [])
      .filter((scene) => scene && typeof scene === "object")
      .map(normalizeServerScene)
      .sort((left, right) => new Date(right.timestamp || 0) - new Date(left.timestamp || 0));
    state.scans = scenes;
    state.findings = scenes.flatMap((scene) => scene.findings);
  }

  async function loadPatientScenes(patient = selectedPatient, { quiet = false } = {}) {
    if (!patient?.id || !session.authenticated) return;
    const requestedId = String(patient.id);
    patientSceneLoading = !quiet;
    patientError = "";
    if (!quiet) render();
    try {
      const payload = await apiFetch(`/api/patients/${encodeURIComponent(requestedId)}/scenes`);
      if (String(selectedPatient?.id || "") !== requestedId) return;
      if (payload.patient) selectedPatient = { ...selectedPatient, ...payload.patient };
      const resultScanId = currentFindings[0]?.scanId;
      applyPatientScenes(payload.scenes);
      if (currentRoute === "results") {
        if (currentResultAggregate) currentFindings = state.findings.filter((finding) => finding.status === "pending");
        else if (resultScanId) {
          const refreshedScene = state.scans.find((scene) => scene.id === resultScanId);
          currentFindings = refreshedScene?.findings || [];
          if (refreshedScene) currentAnalysisSummary = {
            source: "ai",
            mediaType: refreshedScene.mediaType,
            durationSeconds: refreshedScene.durationSeconds,
            framesSent: refreshedScene.framesSent,
            frameTimestamps: [...refreshedScene.frameTimestamps],
            unableToAssess: refreshedScene.unableToAssess,
            assessmentNote: refreshedScene.assessmentNote,
            assessmentStatus: refreshedScene.assessmentStatus,
            assessmentOutcome: refreshedScene.assessmentOutcome,
            model: refreshedScene.model,
          };
        }
      }
    } catch (error) {
      if (String(selectedPatient?.id || "") !== requestedId) return;
      patientError = error.status === 403 || error.status === 404
        ? "You no longer have access to this patient."
        : error.message;
      if ([403, 404].includes(error.status)) resetPatientData();
    } finally {
      if (String(selectedPatient?.id || "") === requestedId || !selectedPatient) {
        patientSceneLoading = false;
        render();
      }
    }
  }

  async function selectPatient(patient, { route = "home" } = {}) {
    if (!patient?.id) return;
    clearTimeout(patientSearchTimer);
    if (patientSearchController) patientSearchController.abort();
    patientSearchController = null;
    cancelActiveAnalysis();
    clearMediaPreview();
    resetPatientData();
    selectedPatient = { ...patient };
    patientQuery = "";
    patientSearchOpen = false;
    patientActiveIndex = -1;
    patientSuggestions = [];
    currentRoute = route;
    window.history.pushState({ route, scanStep: 0 }, "");
    await loadPatientScenes(selectedPatient);
    window.scrollTo(0, 0);
  }

  function restorePatientSearchFocus() {
    requestAnimationFrame(() => {
      const input = document.querySelector("#patient-search");
      if (!input) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  async function loadPatientDirectory(query = "", { restoreSearchFocus = false } = {}) {
    if (patientSearchController) patientSearchController.abort();
    const controller = new AbortController();
    patientSearchController = controller;
    patientSearchLoading = true;
    if (!query) patientDirectoryLoading = true;
    patientError = "";
    render();
    if (restoreSearchFocus) restorePatientSearchFocus();
    try {
      const payload = await apiFetch(`/api/patients?q=${encodeURIComponent(query)}`, { signal: controller.signal });
      if (controller !== patientSearchController) return;
      const patients = Array.isArray(payload.patients) ? payload.patients : [];
      patientSuggestions = patients;
      if (!query) patientDirectory = patients;
    } catch (error) {
      if (error?.name !== "AbortError") patientError = error.message;
    } finally {
      if (controller === patientSearchController) {
        patientSearchController = null;
        patientSearchLoading = false;
        patientDirectoryLoading = false;
        render();
        if (restoreSearchFocus) restorePatientSearchFocus();
      }
    }
  }

  async function bootstrapSession() {
    session.status = "loading";
    render();
    try {
      const payload = await apiFetch("/api/session");
      session = {
        status: "ready",
        authenticated: payload.authenticated === true,
        setupRequired: payload.setupRequired === true,
        user: payload.user || null,
        csrfToken: typeof payload.csrfToken === "string" ? payload.csrfToken : "",
        expiresAt: Number.isFinite(Number(payload.expiresAt)) ? Number(payload.expiresAt) : null,
      };
      if (session.authenticated) {
        scheduleSessionExpiry(session.expiresAt);
        currentRoute = "patients";
        await loadPatientDirectory("");
      } else {
        clearSessionExpiryTimer();
        clearSensitiveClientState();
      }
    } catch (error) {
      clearSessionExpiryTimer();
      clearSensitiveClientState();
      session = { status: "error", authenticated: false, setupRequired: false, user: null, csrfToken: "", expiresAt: null };
      authError = error.message;
    }
    render();
  }

  function revalidateSession() {
    if (sessionRevalidationPromise) return sessionRevalidationPromise;
    sessionRevalidationPromise = (async () => {
      try {
        const payload = await apiFetch("/api/session");
        if (payload.authenticated !== true) {
          transitionToSignedOut({ setupRequired: payload.setupRequired === true });
          return;
        }

        const previousUserId = String(session.user?.id || "");
        const nextUser = payload.user || session.user || null;
        const nextUserId = String(nextUser?.id || "");
        const identityChanged = session.authenticated && previousUserId && nextUserId && previousUserId !== nextUserId;
        const needsPatientPicker = !session.authenticated || identityChanged;
        if (needsPatientPicker) clearSensitiveClientState();
        session = {
          status: "ready",
          authenticated: true,
          setupRequired: false,
          user: nextUser,
          csrfToken: typeof payload.csrfToken === "string" ? payload.csrfToken : session.csrfToken,
          expiresAt: Number.isFinite(Number(payload.expiresAt)) ? Number(payload.expiresAt) : null,
        };
        scheduleSessionExpiry(session.expiresAt);

        if (needsPatientPicker) {
          currentRoute = "patients";
          window.history.replaceState({ route: "patients", scanStep: 0 }, "");
          await loadPatientDirectory("");
        } else if (selectedPatient && ["home", "history", "care", "results"].includes(currentRoute)) {
          await loadPatientScenes(selectedPatient, { quiet: true });
        } else if (!selectedPatient) {
          render();
        }
      } catch (error) {
        if (error.status !== 401) showToast("Session check failed. You are still signed in.");
      } finally {
        sessionRevalidationPromise = null;
      }
    })();
    return sessionRevalidationPromise;
  }

  function renderAuthScreen(mode) {
    const setup = mode === "setup";
    const loading = mode === "loading";
    return `<div class="screen auth-screen">
      <section class="auth-card" aria-labelledby="auth-title">
        <div class="auth-brand"><span class="brand-mark">${icon("shield")}</span><strong>careview</strong></div>
        ${loading
          ? `<div class="loading-state" role="status"><span class="loading-spinner" aria-hidden="true"></span><div><h1 id="auth-title">Opening Careview</h1><p>Checking your secure session…</p></div></div>`
          : `<p class="eyebrow">${setup ? "First-time setup" : "Healthcare access"}</p>
             <h1 id="auth-title">${setup ? "Create the first administrator" : "Sign in to Careview"}</h1>
             <p class="lead">${setup ? "Set up this private workspace. The first account can add healthcare staff and patients." : "Use your assigned healthcare account to access authorized patients."}</p>
             <form class="auth-form" data-form="${setup ? "setup" : "login"}">
               ${setup ? `<label class="field-label" for="workspace-name">Workspace name</label><input class="text-input" id="workspace-name" name="workspaceName" autocomplete="organization" minlength="2" maxlength="80" value="${escapeHtml(authDraft.workspaceName)}" required />
                 <label class="field-label" for="setup-name">Your display name</label><input class="text-input" id="setup-name" name="displayName" autocomplete="name" minlength="2" maxlength="100" value="${escapeHtml(authDraft.displayName)}" required />` : ""}
               <label class="field-label" for="auth-email">Email</label><input class="text-input" id="auth-email" name="email" type="email" inputmode="email" autocomplete="username" maxlength="254" value="${escapeHtml(authDraft.email)}" required />
               <label class="field-label" for="auth-password">Password</label><input class="text-input" id="auth-password" name="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}" minlength="${setup ? 14 : 1}" maxlength="200" required />
               ${setup ? '<p class="field-help">Use 14–200 characters with uppercase, lowercase, a number, and a symbol.</p>' : ""}
               <p class="form-error" role="alert" ${authError ? "" : "hidden"}>${escapeHtml(authError)}</p>
               <button class="primary-button" type="submit" ${authBusy ? "disabled" : ""}>${authBusy ? "Please wait…" : setup ? "Create workspace" : "Sign in"}</button>
             </form>`}
      </section>
      <p class="auth-privacy">Use Careview only over your organization’s secure HTTPS address. Access is limited to authorized staff.</p>
    </div>`;
  }

  function renderPatientOption(patient, index, inListbox = false) {
    const id = String(patient?.id || "");
    const name = displayName(patient, "Unnamed patient");
    const location = String(patient?.careLocation ?? patient?.care_location ?? "Care location not provided");
    return `<button class="patient-option" ${inListbox ? `id="patient-option-${index}" role="option" aria-selected="false"` : ""} type="button" data-action="select-patient" data-patient-id="${escapeHtml(id)}">
      <span class="person-avatar">${escapeHtml(initialsFor(patient))}</span><span class="patient-option-copy"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(location)}</span></span><span class="setting-arrow" aria-hidden="true">›</span>
    </button>`;
  }

  function renderPatients() {
    const shownPatients = patientSearchOpen ? patientSuggestions : patientDirectory;
    const statusText = patientSearchLoading ? "Searching patients…" : patientSearchOpen ? `${shownPatients.length} suggestion${shownPatients.length === 1 ? "" : "s"}` : `${shownPatients.length} authorized patient${shownPatients.length === 1 ? "" : "s"}`;
    return `<div class="screen page-pad patients-screen">
      <p class="eyebrow">Patient workspace</p><h1>Select a patient</h1>
      <p class="lead">Search only returns patients your healthcare account is authorized to access.</p>
      <div class="patient-search-wrap">
        <label class="field-label" for="patient-search">Search by patient name</label>
        <div class="search-input-wrap">${icon("search")}<input class="text-input" id="patient-search" type="search" role="combobox" autocomplete="off" maxlength="100" aria-autocomplete="list" aria-controls="patient-suggestions" aria-expanded="${patientSearchOpen}" aria-activedescendant="" placeholder="Start typing a name" value="${escapeHtml(patientQuery)}" /></div>
        <div class="suggestion-list" id="patient-suggestions" role="listbox" ${patientSearchOpen ? "" : "hidden"}>
          ${shownPatients.length ? shownPatients.map((patient, index) => renderPatientOption(patient, index, true)).join("") : `<div class="empty-suggestion" role="status">${patientSearchLoading ? "Searching…" : "No authorized patients match that name."}</div>`}
        </div>
        <p class="field-help" id="patient-search-status" role="status" aria-live="polite">${escapeHtml(statusText)}</p>
      </div>
      ${patientError ? `<p class="form-error" role="alert">${escapeHtml(patientError)}</p>` : ""}
      <div class="section-heading patient-list-heading"><h2>Patients</h2><span class="muted small">Shared workspace</span></div>
      <div class="patient-list">
        ${patientDirectoryLoading ? '<div class="loading-row" role="status"><span class="loading-spinner"></span>Loading patients…</div>' : patientDirectory.length ? patientDirectory.map((patient, index) => renderPatientOption(patient, index)).join("") : '<div class="empty-state"><strong>No patients yet</strong><span>Add the first patient to begin a scene review.</span></div>'}
      </div>
      <details class="add-panel" ${patientMutationBusy || patientError || !patientDirectory.length ? "open" : ""}>
        <summary>${icon("plus")} Add patient</summary>
        <form class="stack-form" data-form="add-patient">
          <label class="field-label" for="patient-name">Patient display name</label><input class="text-input" id="patient-name" name="displayName" autocomplete="off" minlength="2" maxlength="120" value="${escapeHtml(patientDraft.displayName)}" required />
          <label class="field-label" for="care-location">Care location <span class="muted">(optional)</span></label><input class="text-input" id="care-location" name="careLocation" autocomplete="off" maxlength="120" placeholder="Home, residence, or unit" value="${escapeHtml(patientDraft.careLocation)}" />
          <p class="form-error" role="alert" ${patientError ? "" : "hidden"}>${escapeHtml(patientError)}</p>
          <button class="primary-button" type="submit" ${patientMutationBusy ? "disabled" : ""}>${patientMutationBusy ? "Adding…" : "Add and select patient"}</button>
        </form>
      </details>
    </div>`;
  }

  function patientContext() {
    if (!selectedPatient) return "";
    return `<button class="patient-context" type="button" data-route="patients" aria-label="Switch patient. Current patient: ${escapeHtml(displayName(selectedPatient, "Patient"))}">
      <span class="person-avatar">${escapeHtml(initialsFor(selectedPatient))}</span><span><small>Current patient</small><strong>${escapeHtml(displayName(selectedPatient, "Patient"))}</strong></span><span aria-hidden="true">Switch</span>
    </button>`;
  }

  function render() {
    closeSheet(false);
    const authenticated = session.status === "ready" && session.authenticated;
    appShell.classList.toggle("auth-mode", !authenticated);
    appHeader.hidden = !authenticated;
    nav.hidden = !authenticated;
    if (userMenuButton && session.user) userMenuButton.setAttribute("aria-label", `Open account settings for ${displayName(session.user)}`);
    if (userInitials) userInitials.textContent = initialsFor(session.user);

    if (session.status === "loading") app.innerHTML = renderAuthScreen("loading");
    else if (session.status === "error") app.innerHTML = renderAuthScreen("login");
    else if (session.setupRequired && !session.authenticated) app.innerHTML = renderAuthScreen("setup");
    else if (!session.authenticated) app.innerHTML = renderAuthScreen("login");
    else {
      if (!selectedPatient && ["home", "scan", "analyzing", "results", "history"].includes(currentRoute)) currentRoute = "patients";
      if (currentRoute === "patients") app.innerHTML = renderPatients();
      if (currentRoute === "home") app.innerHTML = renderHome();
      if (currentRoute === "scan") app.innerHTML = renderScan();
      if (currentRoute === "analyzing") app.innerHTML = renderAnalyzing();
      if (currentRoute === "results") app.innerHTML = renderResults();
      if (currentRoute === "history") app.innerHTML = renderHistory();
      if (currentRoute === "care") app.innerHTML = renderCare();
    }

    const hideNav = !authenticated || ["scan", "analyzing", "results"].includes(currentRoute);
    nav.classList.toggle("hidden", hideNav);
    document.querySelectorAll(".nav-item").forEach((item) => {
      const active = item.dataset.route === currentRoute;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
  }

  function renderHome() {
    if (patientSceneLoading) return `<div class="screen page-pad">${patientContext()}<div class="loading-row" role="status"><span class="loading-spinner"></span>Loading shared patient history…</div></div>`;
    const pending = state.findings.filter((finding) => finding.status === "pending").length;
    const latest = state.scans[0] || { zone: "No area checked", count: 0, date: "Not started" };
    const foodPending = state.findings.filter((finding) => finding.status === "pending" && finding.category === "Food").length;
    const medicationPending = state.findings.filter((finding) => finding.status === "pending" && finding.category === "Medication").length;
    const homePending = state.findings.filter((finding) => finding.status === "pending" && finding.category === "Cleanliness").length;
    const baselineCount = state.scans.filter((scan) => ["Kitchen", "Fridge & freezer"].includes(scan.zoneLabel || scan.zone)).length;
    const showIosInstall = isIosDevice() && !isStandaloneMode() && !state.settings.iosInstallDismissed;
    return `
      <div class="screen">
        <section class="home-hero">
          ${patientContext()}
          ${patientError ? `<p class="form-error" role="alert">${escapeHtml(patientError)}</p>` : ""}
          <p class="eyebrow">${escapeHtml(new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }))}</p>
          <h1>Welcome, ${escapeHtml(displayName(session.user, "caregiver"))}.</h1>
          <p class="lead">A calm check-in helps you notice small changes before they become bigger concerns.</p>

          <div class="care-summary">
            <div class="summary-top">
              <div class="person-lockup">
                <span class="person-avatar">${escapeHtml(initialsFor(selectedPatient))}</span>
                <div><strong>${escapeHtml(displayName(selectedPatient, "Patient"))}</strong><span>${escapeHtml(String(selectedPatient?.careLocation ?? selectedPatient?.care_location ?? "Care location not provided"))}</span></div>
              </div>
              <span class="consent-chip">Sample profile · upload consent required</span>
            </div>
            <div class="summary-copy">
              <p>Care summary</p>
              <strong>${pending ? `${pending} observations need your review` : "Everything reviewed for now"}</strong>
            </div>
            <button class="primary-button" type="button" data-action="start-scan">
              ${icon("camera")} Start a scene check
            </button>
            ${pending ? `<button class="summary-review-button" type="button" data-action="review-pending">Review ${pending} pending observation${pending === 1 ? "" : "s"} <span aria-hidden="true">›</span></button>` : ""}
          </div>
          ${
            showIosInstall
              ? `<aside class="ios-install-card" aria-labelledby="ios-install-title">
                  <span class="ios-install-icon">${icon("share")}</span>
                  <div class="ios-install-copy">
                    <strong id="ios-install-title">Install Careview on this iPhone</strong>
                    <span>Open it from your Home Screen like an app.</span>
                  </div>
                  <div class="install-actions">
                    <button class="quiet-button" type="button" data-action="dismiss-ios-install">Not now</button>
                    <button class="secondary-button" type="button" data-action="show-ios-install">Show me how</button>
                  </div>
                </aside>`
              : ""
          }
        </section>

        <section class="section" aria-labelledby="watching-title">
          <div class="section-heading">
            <h2 id="watching-title">What we're watching</h2>
            <button class="section-link" type="button" data-route="history">View trends</button>
          </div>
          <div class="category-grid">
            <article class="category-card">
              <span class="category-icon food-bg">${icon("food")}</span>
              <strong>Food</strong><span>${foodPending ? `${foodPending} pending` : "None pending"}</span>
            </article>
            <article class="category-card">
              <span class="category-icon med-bg">${icon("medication")}</span>
              <strong>Medicine</strong><span>${medicationPending ? `${medicationPending} pending` : "None pending"}</span>
            </article>
            <article class="category-card">
              <span class="category-icon clean-bg">${icon("cleanliness")}</span>
              <strong>Home</strong><span>${homePending ? `${homePending} pending` : "None pending"}</span>
            </article>
          </div>
        </section>

        <section class="section" aria-labelledby="activity-title">
          <div class="section-heading">
            <h2 id="activity-title">Recent activity</h2>
            <button class="section-link" type="button" data-route="history">See all</button>
          </div>
          <div class="activity-card">
            <div class="activity-row">
              <span class="timeline-icon ${latest.count ? "clean-bg" : "food-bg"}">${icon(latest.count ? "cleanliness" : "check")}</span>
              <div class="activity-copy">
                <h3>${escapeHtml(latest.zoneLabel || latest.zone)} reviewed</h3>
                <p>${latest.zone === "No area checked" ? "Start a consented scene check to create shared history" : latest.count ? `${latest.count} observations were recorded for caregiver review` : "No observations were returned; verify the scene in person"}</p>
              </div>
              <span class="activity-time">${displayDate(latest)}</span>
            </div>
            <div class="activity-row">
              <span class="timeline-icon food-bg">${icon("trend")}</span>
              <div class="activity-copy">
                <h3>${baselineCount >= 3 ? "More comparable scenes available" : "Baseline needs more scenes"}</h3>
                <p>${baselineCount} shared kitchen and fridge check${baselineCount === 1 ? "" : "s"}</p>
              </div>
              <span class="activity-time">3 days</span>
            </div>
          </div>
        </section>

        <div class="context-note">
          ${icon("info")}
          <span>Careview describes visible observations for caregiver review. It does not diagnose a condition, prove a habit from one scene check, or provide emergency monitoring.</span>
        </div>
      </div>`;
  }

  function renderScan() {
    if (scanStep === 1) return renderZoneStep();
    if (scanStep === 2) return renderCaptureStep();
    return renderReviewStep();
  }

  function scanHeader(title, subtitle) {
    return `
      <div class="page-top">
        <button class="back-button" type="button" data-action="scan-back">${icon("back")} Back</button>
        <div class="progress-wrap">
          <div class="progress-track" aria-hidden="true"><div class="progress-fill" style="width:${scanStep * 33.333}%"></div></div>
          <span class="progress-label">${scanStep} of 3</span>
        </div>
        <p class="eyebrow">Guided scene check</p>
        <h1>${title}</h1>
        <p class="lead">${subtitle}</p>
      </div>`;
  }

  function renderZoneStep() {
    return `
      <div class="screen page-pad">
        <button class="back-button" type="button" data-action="scan-back">${icon("back")} Home</button>
        <div class="progress-wrap">
          <div class="progress-track" aria-hidden="true"><div class="progress-fill" style="width:33.333%"></div></div>
          <span class="progress-label">1 of 3</span>
        </div>
        <p class="eyebrow">Guided scene check</p>
        <h1>Which area are you checking?</h1>
        <p class="lead">Choose one area at a time so each observation stays specific and easy to verify.</p>
        <div class="zone-grid">
          ${Object.entries(zones)
            .map(
              ([key, zone]) => `
                <button class="zone-card ${selectedZone === key ? "selected" : ""}" type="button" data-action="select-zone" data-zone="${key}" aria-pressed="${selectedZone === key}">
                  <span class="zone-icon">${icon(zone.icon)}</span>
                  <strong>${zone.name}</strong>
                  <span>${zone.description}</span>
                </button>`,
            )
            .join("")}
        </div>
        <div class="privacy-note">${icon("shield")}<span>Only capture a space with ${escapeHtml(displayName(selectedPatient, "the patient"))}'s or an authorized representative's consent. Avoid faces, voices, screens, mail, financial documents, addresses, and prescription labels.</span></div>
        <div class="scan-footer">
          <button class="primary-button" type="button" data-action="scan-next" ${selectedZone ? "" : "disabled"}>Continue ${icon("arrow")}</button>
        </div>
      </div>`;
  }

  function renderCaptureStep() {
    const zone = zones[selectedZone];
    const hasMedia = Boolean(mediaPreview || isDemoMedia);
    return `
      <div class="screen page-pad">
        ${scanHeader(`Capture the ${zone.name.toLowerCase()}`, `${zone.prompt} Choose a photo or a short video.`)}
        <div class="capture-frame ${hasMedia ? "has-image" : ""} ${mediaType === "video" ? "video-media" : ""}">
          ${renderMediaPreview()}
          ${
            hasMedia
              ? `<div class="capture-overlay"><span><i class="quality-dot"></i> ${mediaType === "video" ? "Video ready" : "Image ready"}</span><span>${formatMediaMeta()}</span></div>`
              : `<div class="capture-prompt">${icon("camera")}<strong>Photo or short video</strong><span>Use good light, move slowly, and include the whole area. Videos can be up to 30 seconds.</span></div>`
          }
        </div>
        <div class="capture-actions" aria-label="Add scene media">
          <label class="secondary-button" for="scene-photo" aria-disabled="${mediaLoading}">${icon("camera")} Take photo</label>
          <input class="file-input scene-media-input" id="scene-photo" type="file" accept="image/*" capture="environment" aria-describedby="media-help media-error" ${mediaLoading ? "disabled" : ""} />
          <label class="secondary-button" for="scene-video" aria-disabled="${mediaLoading}">${icon("video")} Record video</label>
          <input class="file-input scene-media-input" id="scene-video" type="file" accept="video/*" capture="environment" aria-describedby="media-help media-error" ${mediaLoading ? "disabled" : ""} />
          <label class="secondary-button" for="scene-media" aria-disabled="${mediaLoading}">${icon("image")} ${hasMedia ? "Replace from library" : "Choose from library"}</label>
          <input class="file-input scene-media-input" id="scene-media" type="file" accept="image/*,video/*" aria-describedby="media-help media-error" ${mediaLoading ? "disabled" : ""} />
          <button class="secondary-button" type="button" data-action="use-demo">${icon("sparkle")} Demo video</button>
        </div>
        <p class="media-help" id="media-help">On iPhone, Take photo and Record video request the rear camera. Capture is a browser hint, so check the selected media before continuing. Images: up to 12 MB. Videos: 1–30 seconds, up to 100 MB, 480p–4K.</p>
        <p class="media-error" id="media-error" role="alert" ${mediaError ? "" : "hidden"}>${escapeHtml(mediaError)}</p>
        <div class="privacy-note" style="margin-top:12px">${icon("lock")}<span>${isDemoMedia ? "The illustrated demo stays on this device and is never uploaded." : "The selected file stays temporarily on this device during the current check. Images are resized to JPEG; videos are converted to at most six silent still frames. Raw video and audio are never sent."}</span></div>
        <div class="scan-footer">
          <button class="primary-button" type="button" data-action="scan-next" ${hasMedia && !mediaLoading ? "" : "disabled"}>Review ${mediaType === "video" ? "video" : "image"} ${icon("arrow")}</button>
        </div>
      </div>`;
  }

  function renderMediaPreview() {
    if (mediaPreview && mediaType === "video") {
      return `<video class="capture-preview" src="${mediaPreview}" controls muted playsinline preload="metadata" aria-label="Selected ${zones[selectedZone].name} video preview"></video>`;
    }
    if (mediaPreview) return `<img class="capture-preview" src="${mediaPreview}" alt="Selected ${zones[selectedZone].name} image preview" />`;
    if (isDemoMedia) return renderDemoScene();
    return "";
  }

  function formatMediaMeta() {
    if (!mediaMeta) return "Illustrated demo";
    if (mediaType === "video") return `${formatDuration(mediaMeta.duration)} · ${mediaMeta.width} × ${mediaMeta.height}`;
    return `${mediaMeta.width} × ${mediaMeta.height}`;
  }

  function formatDuration(seconds) {
    const safeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
    const minutes = Math.floor(safeSeconds / 60);
    return `${minutes}:${String(safeSeconds % 60).padStart(2, "0")}`;
  }

  function formatEvidenceTimestamp(seconds) {
    const safeSeconds = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = (safeSeconds - minutes * 60).toFixed(1).padStart(4, "0");
    return `${minutes}:${remainder}`;
  }

  function renderVideoSamplingPlan() {
    if (mediaType !== "video" || !mediaMeta) return "";
    const times = mediaMeta.sampleTimes || [];
    return `<div class="frame-sampling" aria-label="${isDemoMedia ? "Illustrative production" : "AI frame sampling"} plan">
      <div class="row-between"><div><strong>${isDemoMedia ? "Illustrative production plan" : "Silent frame upload plan"}</strong><span>${mediaMeta.sampleCount} ${isDemoMedia ? "example" : "planned"} timestamps across ${formatDuration(mediaMeta.duration)}</span></div><span class="video-chip">${isDemoMedia ? "Not processed" : "On Analyze"}</span></div>
      <div class="frame-track" aria-hidden="true">${times.map((time) => `<i style="left:${Math.min(96, Math.max(4, (time / mediaMeta.duration) * 100))}%"></i>`).join("")}</div>
      <p>${isDemoMedia ? "No frames are inspected in this prototype. A production service could sample these points, may miss brief details, and must not analyze audio." : "Careview will upload at most six resized JPEG stills at these timestamps. Raw video and audio stay on this device; brief details between frames may be missed."}</p>
    </div>`;
  }

  function renderDemoScene() {
    const zone = zones[selectedZone];
    const objects = {
      kitchen: '<i class="cabinet"></i><i class="fridge"></i><i class="counter"></i><i class="bowl"></i><i class="spill"></i>',
      fridge: '<i class="demo-fridge-body"></i><i class="demo-shelf shelf-one"></i><i class="demo-shelf shelf-two"></i><i class="demo-food food-one"></i><i class="demo-food food-two"></i>',
      medication: '<i class="demo-countertop"></i><i class="demo-organizer"></i><i class="demo-bottle bottle-one"></i><i class="demo-bottle bottle-two"></i><i class="demo-tablet tablet-one"></i><i class="demo-tablet tablet-two"></i>',
      living: '<i class="demo-wall"></i><i class="demo-sofa"></i><i class="demo-table"></i><i class="demo-basket"></i><i class="demo-rug"></i>',
    };
    return `<div class="sample-scene sample-${selectedZone}" role="img" aria-label="Illustrated ${zone.name} demo scene">
      <span class="sample-label">${zone.name} · demo</span>${objects[selectedZone]}${mediaType === "video" ? `<span class="demo-video-badge">${formatDuration(mediaMeta?.duration)} · muted</span><i class="demo-scan-line"></i>` : ""}
    </div>`;
  }

  function renderReviewStep() {
    const zone = zones[selectedZone];
    const isRealAnalysis = !isDemoMedia && Boolean(selectedMediaFile);
    return `
      <div class="screen page-pad">
        ${scanHeader(isRealAnalysis ? "Review before AI analysis" : "Review the demo scene", "Make sure the scene is useful and remove anything you do not want included.")}
        <div class="capture-frame has-image ${mediaType === "video" ? "video-media" : ""}" style="min-height:250px">
          ${renderMediaPreview()}
          <div class="capture-overlay"><span><i class="quality-dot"></i> ${mediaType === "video" ? "Video selected" : "Image selected"} · quality not assessed</span><span>${zone.name}</span></div>
        </div>
        ${renderVideoSamplingPlan()}
        <div class="check-list">
          <div class="check-item">${icon("check")}<div><strong>${mediaType === "video" ? "Video" : "Image"} selected for review</strong><span>Confirm the important parts of the ${zone.name.toLowerCase()} are visible. AI may still miss, misread, or be unable to assess visible details.</span></div></div>
          <div class="check-item">${icon("shield")}<div><strong>Manual privacy check required</strong><span>Automated redaction is not active. Review the entire ${mediaType === "video" ? "clip" : "image"} and remove media containing faces, mail, prescription labels, or other identifying information.</span></div></div>
        </div>
        ${
          isRealAnalysis
            ? `<label class="check-item" for="analysis-consent"><input id="analysis-consent" type="checkbox" ${analysisConsentConfirmed ? "checked" : ""} /><div><strong>Consent and privacy confirmation</strong><span>I confirm this is ${window.isSecureContext ? "test media or the resident/authorized representative consented to this upload" : "non-sensitive test media; I will not upload real resident information over plain HTTP"}, and I reviewed it for faces, voices, labels, and other identifiers.</span></div></label>
               <div class="demo-banner">${icon("sparkle")}<span><strong>${window.isSecureContext ? "AI-assisted review:" : "Plain HTTP test only:"}</strong> ${!window.isSecureContext ? "This connection is not encrypted; use only non-sensitive test media. " : ""}${mediaType === "video" ? "At most six resized, silent video stills" : "One resized JPEG"} will be sent to the configured backend; raw video and audio stay local. Automated redaction is not active. Derived results and caregiver reviews are saved to this patient's shared workspace. ${window.isSecureContext ? "Use only consented media" : "Use only non-sensitive test media"}, and verify every result in person.</span></div>`
            : `<div class="demo-banner">${icon("sparkle")}<span><strong>Prototype mode:</strong> this review returns representative sample observations. It is not running a real vision model on your image or video.</span></div>`
        }
        <p class="media-error" id="analysis-error" role="alert" ${mediaError ? "" : "hidden"}>${escapeHtml(mediaError)}</p>
        <div class="button-row">
          <button class="secondary-button" type="button" data-action="scan-back">${icon("refresh")} Retake</button>
          <button class="primary-button" type="button" data-action="analyze" ${isRealAnalysis && !analysisConsentConfirmed ? "disabled" : ""}>${isRealAnalysis ? "Analyze scene with AI" : "Show demo observations"} ${icon("arrow")}</button>
        </div>
      </div>`;
  }

  function renderAnalyzing() {
    const isRealAnalysis = !isDemoMedia;
    return `
      <div class="screen analyzing" aria-live="polite">
        <div class="analysis-orb">${icon("sparkle")}</div>
        <p class="eyebrow">${isRealAnalysis ? "AI-assisted scene review" : "Prototype output"}</p>
        <h1>${isRealAnalysis ? "Analyzing visible details…" : "Preparing demo observations…"}</h1>
        <p class="lead">${isRealAnalysis ? `Careview is preparing ${mediaType === "video" ? "silent still frames" : "a resized image"} and sending only those JPEGs for analysis. Results will still need human review.` : "Careview is not inspecting the selected media in this build. The next screen demonstrates the caregiver review workflow."}</p>
        <div class="analysis-steps" id="analysis-status" role="status" aria-live="polite" aria-atomic="true"><span>${analysisProgressMessage || (mediaType === "video" ? "No video frames are being inspected" : "The image is not being inspected")}</span></div>
        <button class="secondary-button" type="button" data-action="cancel-analysis">Cancel and return to review</button>
        ${isRealAnalysis ? '<p class="small muted">Cancel stops waiting on this device. If the server already sent the request, that provider request may still finish.</p>' : ""}
      </div>`;
  }

  function createFindings(zoneKey) {
    const stamp = Date.now();
    const sets = {
      kitchen: [
        {
          category: "Cleanliness",
          title: "Liquid-shaped area near refrigerator",
          observed: "A reflective, irregular area is visible on the floor beside the refrigerator.",
          meaning: "If wet, this could increase slip risk. The selected media cannot confirm the material or whether it is still present.",
          action: "Check the floor in person and clean or dry it if needed.",
          urgency: "now",
          urgencyLabel: "Check now",
          confidence: null,
          limitation: "Floor reflections and patterns may resemble liquid.",
        },
        {
          category: "Cleanliness",
          title: "Counter has more items than baseline",
          observed: "Seven loose items are visible in the main food-preparation area; recent checks showed two to four.",
          meaning: "The usable preparation area may be reduced. This is a visual comparison, not a judgment about housekeeping.",
          action: "Ask whether the patient would like help clearing the food-preparation area.",
          urgency: "soon",
          urgencyLabel: "Review soon",
          confidence: null,
          limitation: "The full counter is not visible and items may be in active use.",
        },
      ],
      fridge: [
        {
          category: "Food",
          title: "Fresh-food variety looks lower",
          observed: "One fresh item is visible where three comparable reviews typically showed four to six.",
          meaning: "This differs from the visual baseline. It does not establish appetite, nutrition, or eating behavior.",
          action: "Ask whether groceries or meal support are needed this week.",
          urgency: "soon",
          urgencyLabel: "Review soon",
          confidence: null,
          limitation: "Food may be outside the frame, in opaque containers, or stored elsewhere.",
        },
        {
          category: "Food",
          title: "Uncovered prepared food visible",
          observed: "A bowl containing prepared food appears uncovered on the middle shelf.",
          meaning: "Uncovered food may be more exposed to contamination or drying.",
          action: "Verify what the food is, when it was prepared, and whether it should be covered or discarded.",
          urgency: "soon",
          urgencyLabel: "Review soon",
          confidence: null,
          limitation: "A clear lid may not be visible in this lighting.",
        },
      ],
      medication: [
        {
          category: "Medication",
          title: "Two loose tablet-shaped items visible",
          observed: "Two small round items are visible beside the weekly organizer.",
          meaning: "They may be loose tablets, but visual media cannot identify them or establish whether any dose was missed.",
          action: "Check the area in person and verify the items against the medication list or with a pharmacist.",
          urgency: "now",
          urgencyLabel: "Check now",
          confidence: null,
          limitation: "Small objects can be misidentified in a captured scene.",
        },
        {
          category: "Medication",
          title: "Organizer differs from configured visual plan",
          observed: "The Tuesday evening compartment appears full in the representative scene; the configured review plan marks it for a visual check.",
          meaning: "This is an organizer-state observation only. It does not prove whether medicine was taken.",
          action: "Confirm the compartment and schedule with the patient. Do not change a dose without a clinician or pharmacist.",
          urgency: "soon",
          urgencyLabel: "Review soon",
          confidence: null,
          limitation: "Compartment labels and contents are only partly visible.",
        },
      ],
      living: [
        {
          category: "Cleanliness",
          title: "Main walking path appears narrowed",
          observed: "A laundry basket and two loose objects extend into the visible path between the chair and doorway.",
          meaning: "Objects in a common route may increase trip risk, especially when lighting is low.",
          action: "Check the route in person and move objects if the patient agrees.",
          urgency: "now",
          urgencyLabel: "Check now",
          confidence: null,
          limitation: "Depth and clear walking width are estimated from one view.",
        },
        {
          category: "Food",
          title: "Uncovered plate remains on side table",
          observed: "A plate with food-like material is visible on the side table.",
          meaning: "If it has been left for a long time, it may need attention. The selected media has no reliable context about when it was placed there.",
          action: "Ask when it was placed there and remove it if no longer wanted.",
          urgency: "monitor",
          urgencyLabel: "Monitor",
          confidence: null,
          limitation: "The contents and how long they have been present are unknown.",
        },
      ],
    };
    return sets[zoneKey].map((finding, index) => ({
      ...finding,
      id: `finding-${stamp}-${index}`,
      status: "pending",
      note: "",
      zone: zones[zoneKey].name,
      date: "Just now",
    }));
  }

  function setAnalysisProgress(message, runToken) {
    if (runToken !== analysisRunToken || currentRoute !== "analyzing") return;
    analysisProgressMessage = message;
    const status = document.querySelector("#analysis-status span");
    if (status) status.textContent = message;
  }

  function ensureActiveAnalysis(runToken, signal) {
    if (runToken !== analysisRunToken || signal.aborted || currentRoute !== "analyzing") {
      throw new DOMException("Analysis cancelled", "AbortError");
    }
  }

  function analysisDimensions(width, height) {
    const scale = Math.min(1, MAX_ANALYSIS_EDGE / Math.max(width, height));
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  function encodeJpeg(source, sourceWidth, sourceHeight) {
    const dimensions = analysisDimensions(sourceWidth, sourceHeight);
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser could not prepare the media for analysis.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    canvas.width = 1;
    canvas.height = 1;
    if (!dataUrl.startsWith("data:image/jpeg;base64,")) throw new Error("This browser could not encode the media for analysis.");
    return { dataUrl, width: dimensions.width, height: dimensions.height };
  }

  function waitForMediaEvent(target, eventName, signal, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener(eventName, onReady);
        target.removeEventListener("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("The selected media could not be decoded for AI analysis."));
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Analysis cancelled", "AbortError"));
      };
      target.addEventListener(eventName, onReady, { once: true });
      target.addEventListener("error", onError, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("The browser took too long to read the selected media."));
      }, timeoutMs);
      if (signal.aborted) onAbort();
    });
  }

  async function prepareImageForAnalysis(file, signal, runToken) {
    ensureActiveAnalysis(runToken, signal);
    setAnalysisProgress("Preparing one resized JPEG on this device", runToken);
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    try {
      image.src = objectUrl;
      if (typeof image.decode === "function") await image.decode();
      else if (!image.complete) await waitForMediaEvent(image, "load", signal);
      ensureActiveAnalysis(runToken, signal);
      const frame = encodeJpeg(image, image.naturalWidth, image.naturalHeight);
      return { frames: [{ ...frame, timestampSeconds: null }], frameTimestamps: [] };
    } finally {
      image.src = "";
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function seekVideo(video, timestampSeconds, signal) {
    if (Math.abs(video.currentTime - timestampSeconds) < 0.02 && video.readyState >= 2) return;
    const ready = waitForMediaEvent(video, "seeked", signal);
    video.currentTime = timestampSeconds;
    await ready;
  }

  async function prepareVideoForAnalysis(file, signal, runToken) {
    ensureActiveAnalysis(runToken, signal);
    setAnalysisProgress("Sampling up to six silent still frames on this device", runToken);
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    try {
      video.src = objectUrl;
      video.load();
      if (video.readyState < 1) await waitForMediaEvent(video, "loadedmetadata", signal);
      ensureActiveAnalysis(runToken, signal);
      const duration = Number.isFinite(video.duration) ? video.duration : mediaMeta?.duration;
      const plannedTimes = (mediaMeta?.sampleTimes || [])
        .slice(0, MAX_VIDEO_FRAMES)
        .map(Number)
        .filter((time) => Number.isFinite(time) && time >= 0 && time <= duration);
      if (!plannedTimes.length) throw new Error("No usable video timestamps were available for analysis.");
      const frames = [];
      for (let index = 0; index < plannedTimes.length; index += 1) {
        ensureActiveAnalysis(runToken, signal);
        setAnalysisProgress(`Preparing silent frame ${index + 1} of ${plannedTimes.length}`, runToken);
        await seekVideo(video, plannedTimes[index], signal);
        ensureActiveAnalysis(runToken, signal);
        const encoded = encodeJpeg(video, video.videoWidth, video.videoHeight);
        frames.push({ ...encoded, timestampSeconds: Number(video.currentTime.toFixed(2)) });
      }
      return { frames, frameTimestamps: frames.map((frame) => frame.timestampSeconds) };
    } finally {
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
    }
  }

  function requiredAiText(value, fieldName, maxLength) {
    if (typeof value !== "string") throw new Error(`AI response is missing ${fieldName}.`);
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength || /\bdata:[^,\s]+(?:;base64)?,/i.test(normalized)) throw new Error(`AI response has an invalid ${fieldName}.`);
    return normalized;
  }

  function optionalAiText(value, maxLength) {
    if (value == null || value === "") return null;
    if (typeof value !== "string") throw new Error("AI response contains invalid text.");
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength || /\bdata:[^,\s]+(?:;base64)?,/i.test(normalized)) throw new Error("AI response contains invalid text.");
    return normalized;
  }

  function normalizeAiResponse(payload, preparedMedia) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("AI service returned an invalid response.");
    const rawFindings = payload.findings ?? payload.observations;
    if (!Array.isArray(rawFindings) || rawFindings.length > 12) throw new Error("AI service returned an invalid findings list.");
    const explicitAssessmentStatus = payload.assessment_status ?? payload.assessmentStatus;
    if (explicitAssessmentStatus != null && (typeof explicitAssessmentStatus !== "string" || !["assessed", "unable_to_assess"].includes(explicitAssessmentStatus))) throw new Error("AI service returned an invalid assessment status.");
    if (payload.status != null && (typeof payload.status !== "string" || !["completed", "assessed", "unable_to_assess"].includes(payload.status))) throw new Error("AI service returned an invalid assessment status.");
    if (explicitAssessmentStatus != null && payload.status != null && explicitAssessmentStatus !== (payload.status === "completed" ? "assessed" : payload.status)) throw new Error("AI service returned an inconsistent assessment status.");
    const statusValue = explicitAssessmentStatus ?? payload.status;
    if (payload.unableToAssess != null && typeof payload.unableToAssess !== "boolean") throw new Error("AI service returned an invalid assessment status.");
    const unableToAssess = payload.unable_to_assess === true || payload.unableToAssess === true || statusValue === "unable_to_assess";
    if (unableToAssess && rawFindings.length) throw new Error("AI service returned an inconsistent assessment.");
    if (payload.unable_to_assess != null && typeof payload.unable_to_assess !== "boolean") throw new Error("AI service returned an invalid assessment status.");
    if (typeof payload.unable_to_assess === "boolean" && typeof payload.unableToAssess === "boolean" && payload.unable_to_assess !== payload.unableToAssess) throw new Error("AI service returned an inconsistent assessment status.");
    const declaredUnable = typeof payload.unable_to_assess === "boolean" ? payload.unable_to_assess : typeof payload.unableToAssess === "boolean" ? payload.unableToAssess : null;
    if (declaredUnable !== null && statusValue != null && declaredUnable !== (statusValue === "unable_to_assess")) throw new Error("AI service returned an inconsistent assessment status.");
    const categoryMap = {
      food: "Food",
      medication: "Medication",
      medicine: "Medication",
      cleanliness: "Cleanliness",
      safety: "Cleanliness",
      home: "Cleanliness",
    };
    const urgencyMap = {
      now: ["soon", "Review soon"],
      check_now: ["soon", "Review soon"],
      soon: ["soon", "Review soon"],
      review_soon: ["soon", "Review soon"],
      monitor: ["monitor", "Monitor"],
    };
    const findings = rawFindings.map((rawFinding) => {
      if (!rawFinding || typeof rawFinding !== "object" || Array.isArray(rawFinding)) throw new Error("AI service returned an invalid finding.");
      const rawCategory = requiredAiText(rawFinding.category, "finding category", 32).toLowerCase().replaceAll(" ", "_");
      const category = categoryMap[rawCategory];
      if (!category) throw new Error("AI service returned an unsupported finding category.");
      const rawUrgency = requiredAiText(rawFinding.urgency, "finding urgency", 32).toLowerCase().replaceAll(" ", "_");
      const urgency = urgencyMap[rawUrgency];
      if (!urgency) throw new Error("AI service returned an unsupported finding urgency.");
      const rawFrameNumbers = rawFinding.evidenceFrameNumbers ?? rawFinding.evidence_frame_numbers;
      if (!Array.isArray(rawFrameNumbers) || !rawFrameNumbers.length || rawFrameNumbers.length > MAX_VIDEO_FRAMES) throw new Error("AI service returned invalid finding evidence.");
      const evidenceFrameNumbers = [];
      for (const frameNumber of rawFrameNumbers) {
        if (!Number.isInteger(frameNumber) || frameNumber < 1 || frameNumber > preparedMedia.frames.length || evidenceFrameNumbers.includes(frameNumber)) throw new Error("AI service returned invalid finding evidence.");
        evidenceFrameNumbers.push(frameNumber);
      }
      const evidenceTimestamps = evidenceFrameNumbers
        .map((frameNumber) => preparedMedia.frames[frameNumber - 1].timestampSeconds)
        .filter(Number.isFinite);
      const rawEvidenceTimestamps = rawFinding.evidenceTimestampsMs ?? rawFinding.evidence_timestamps_ms;
      if (rawEvidenceTimestamps != null) {
        const expectedEvidenceMs = evidenceFrameNumbers.map((frameNumber) => {
          const seconds = preparedMedia.frames[frameNumber - 1].timestampSeconds;
          return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
        });
        if (!Array.isArray(rawEvidenceTimestamps) || rawEvidenceTimestamps.length !== expectedEvidenceMs.length || !rawEvidenceTimestamps.every((value, index) => value === expectedEvidenceMs[index])) throw new Error("AI service returned invalid finding evidence timestamps.");
      }
      return {
        category,
        title: requiredAiText(rawFinding.title, "finding title", 140),
        observed: requiredAiText(rawFinding.observed ?? rawFinding.visible_observation, "visible observation", 700),
        meaning: requiredAiText(rawFinding.meaning ?? rawFinding.why_it_may_matter ?? rawFinding.why_it_matters, "why it may matter", 700),
        action: requiredAiText(rawFinding.action ?? rawFinding.suggested_caregiver_check ?? rawFinding.suggested_action, "caregiver check", 700),
        urgency: urgency[0],
        urgencyLabel: urgency[1],
        confidence: null,
        limitation: requiredAiText(rawFinding.limitation ?? rawFinding.uncertainty, "uncertainty", 700),
        evidenceFrameNumbers,
        evidenceTimestamps,
      };
    });
    const assessmentNote = optionalAiText(payload.assessment_note ?? payload.assessmentNote, 700);
    if (unableToAssess && !assessmentNote) throw new Error("AI service did not explain why the scene could not be assessed.");
    const statusMap = {
      assessed: "assessed",
      completed: "assessed",
      unable_to_assess: "unable_to_assess",
    };
    const assessmentStatus = statusValue == null
      ? unableToAssess ? "unable_to_assess" : "assessed"
      : statusMap[requiredAiText(statusValue, "assessment status", 40)];
    if (!assessmentStatus || unableToAssess !== (assessmentStatus === "unable_to_assess")) throw new Error("AI service returned an inconsistent assessment status.");
    const rawOutcome = payload.assessmentOutcome ?? payload.assessment_outcome;
    const allowedOutcomes = new Set(["findings_present", "assessed_no_findings", "unable_to_assess", "refused", "incomplete"]);
    const assessmentOutcome = rawOutcome == null ? (unableToAssess ? "unable_to_assess" : findings.length ? "findings_present" : "assessed_no_findings") : requiredAiText(rawOutcome, "assessment outcome", 40);
    if (!allowedOutcomes.has(assessmentOutcome)) throw new Error("AI service returned an invalid assessment outcome.");
    const unableOutcomes = new Set(["unable_to_assess", "refused", "incomplete"]);
    if ((unableToAssess && !unableOutcomes.has(assessmentOutcome)) || (!unableToAssess && unableOutcomes.has(assessmentOutcome)) || (!unableToAssess && findings.length > 0 && assessmentOutcome !== "findings_present") || (!unableToAssess && findings.length === 0 && assessmentOutcome !== "assessed_no_findings")) {
      throw new Error("AI service returned an inconsistent assessment outcome.");
    }
    if (payload.frames_analyzed != null || payload.framesAnalyzed != null) throw new Error("AI service returned an unsupported analyzed-frame claim.");
    const serverCoverage = payload.analysisCoverage ?? payload.analysis_coverage;
    if (serverCoverage != null) {
      const expectedTimestamps = preparedMedia.frames.map((frame) => frame.timestampSeconds == null ? null : Math.round(frame.timestampSeconds * 1000));
      const timestampsMatch = Array.isArray(serverCoverage.timestampsMs) && serverCoverage.timestampsMs.length === expectedTimestamps.length && serverCoverage.timestampsMs.every((value, index) => value === expectedTimestamps[index]);
      if (!serverCoverage || typeof serverCoverage !== "object" || serverCoverage.mediaType !== mediaType || serverCoverage.framesSubmitted !== preparedMedia.frames.length || serverCoverage.audioReviewed !== false || !timestampsMatch) {
        throw new Error("AI service returned invalid frame coverage.");
      }
    }
    return {
      findings,
      unableToAssess,
      assessmentNote,
      assessmentStatus,
      assessmentOutcome,
      model: optionalAiText(payload.model, 100),
    };
  }

  function userFacingAnalysisError(error, timedOut) {
    if (timedOut) return "AI analysis timed out after 90 seconds. Your selected media is still available; please try again.";
    if (error?.name === "AbortError") return "AI analysis was cancelled.";
    if (error instanceof TypeError) return "Careview could not reach the AI service. Check the server connection and try again.";
    const message = typeof error?.message === "string" ? error.message : "";
    if (message.startsWith("AI service") || message.startsWith("AI response") || message.startsWith("No usable") || message.startsWith("The selected") || message.startsWith("This browser") || message.startsWith("The browser")) return message;
    return "Careview could not complete AI analysis. Please review the media and try again.";
  }

  async function requestAiAnalysis(preparedMedia, signal, runToken) {
    ensureActiveAnalysis(runToken, signal);
    const patientId = analysisPatientId;
    if (!patientId || patientId !== String(selectedPatient?.id || "")) throw new DOMException("Analysis cancelled", "AbortError");
    setAnalysisProgress(`Sending ${preparedMedia.frames.length} ${preparedMedia.frames.length === 1 ? "resized JPEG" : "silent JPEG stills"} to the configured AI service`, runToken);
    let payload;
    try {
      payload = await apiFetch(`/api/patients/${encodeURIComponent(patientId)}/analyze`, {
      method: "POST",
      signal,
      body: JSON.stringify({
        zone: selectedZone,
        mediaType,
        frames: preparedMedia.frames,
      }),
      });
    } catch (error) {
      if (error.status === 400 || error.status === 415) throw new Error("AI service rejected the prepared scene. Choose different media and try again.");
      if (error.status === 413) throw new Error("AI service rejected this scene because the prepared images were too large.");
      if (error.status === 429) throw new Error("AI service is busy or its usage limit was reached. Please try again later.");
      if (error.status === 503) throw new Error("AI service is not configured on this server. Ask an administrator to check the server configuration.");
      if (error.status === 504) throw new Error("AI service timed out. Your source media remains available for another try.");
      throw error;
    }
    ensureActiveAnalysis(runToken, signal);
    if (patientId !== String(selectedPatient?.id || "")) throw new DOMException("Analysis cancelled", "AbortError");
    setAnalysisProgress("Validating the AI response before showing it", runToken);
    const rawScene = payload?.scene ?? payload;
    if (!rawScene || typeof rawScene !== "object" || !rawScene.id || !rawScene.assessment) throw new Error("AI service returned an invalid saved scene.");
    return normalizeServerScene(rawScene);
  }

  function completeRealAnalysis(scene, preparedMedia, runToken) {
    if (runToken !== analysisRunToken || currentRoute !== "analyzing") return;
    if (analysisPatientId !== String(selectedPatient?.id || "")) return;
    currentFindings = scene.findings;
    currentAnalysisSummary = {
      source: "ai",
      mediaType: scene.mediaType,
      durationSeconds: scene.durationSeconds,
      framesSent: scene.framesSent || preparedMedia.frames.length,
      frameTimestamps: scene.frameTimestamps.length ? [...scene.frameTimestamps] : [...preparedMedia.frameTimestamps],
      unableToAssess: scene.unableToAssess,
      assessmentNote: scene.assessmentNote,
      assessmentStatus: scene.assessmentStatus,
      assessmentOutcome: scene.assessmentOutcome,
      model: scene.model,
    };
    currentResultAggregate = false;
    state.scans = [scene, ...state.scans.filter((item) => item.id !== scene.id)];
    state.findings = state.scans.flatMap((item) => item.findings || []);
    activeFilter = "All";
    mediaError = "";
    analysisController = null;
    analysisProgressMessage = "";
    currentRoute = "results";
    window.history.replaceState({ route: "results", scanStep }, "");
    render();
    window.scrollTo(0, 0);
  }

  function completeAnalysis() {
    const timestamp = new Date().toISOString();
    const scanId = `scan-${Date.now()}`;
    const selectedMediaType = mediaType || "image";
    const durationSeconds = selectedMediaType === "video" ? mediaMeta?.duration || null : null;
    const plannedFrameCount = selectedMediaType === "video" ? mediaMeta?.sampleCount || 0 : 0;
    currentFindings = createFindings(selectedZone);
    currentFindings.forEach((finding) => {
      finding.scanId = scanId;
      finding.timestamp = timestamp;
      finding.mediaType = selectedMediaType;
      finding.durationSeconds = durationSeconds;
      finding.framesSampled = 0;
      finding.plannedFrameCount = plannedFrameCount;
      finding.source = "demo";
      finding.demoOutput = true;
    });
    currentAnalysisSummary = {
      source: "demo",
      mediaType: selectedMediaType,
      durationSeconds,
      framesSent: 0,
      frameTimestamps: [],
      unableToAssess: false,
      assessmentNote: null,
      assessmentStatus: "demo",
      model: null,
    };
    currentResultAggregate = false;
    // Demo observations are intentionally ephemeral and are never added to the
    // selected patient's shared record.
    if (!state.settings.retain) clearMediaPreview();
    activeFilter = "All";
    currentRoute = "results";
    window.history.replaceState({ route: "results", scanStep }, "");
    render();
    window.scrollTo(0, 0);
  }

  function renderResults() {
    const categories = ["All", ...new Set(currentFindings.map((finding) => finding.category))];
    const visible = activeFilter === "All" ? currentFindings : currentFindings.filter((finding) => finding.category === activeFilter);
    const pendingCount = currentFindings.filter((finding) => finding.status === "pending").length;
    const sourceFinding = currentFindings[0];
    const sources = new Set(currentFindings.map((finding) => finding.source || "demo"));
    const resultSource = currentResultAggregate ? "aggregate" : currentAnalysisSummary?.source || (sources.size > 1 ? "mixed" : [...sources][0] || "demo");
    const isAiResult = resultSource === "ai";
    const unableToAssess = Boolean(currentAnalysisSummary?.unableToAssess);
    const framesSent = currentAnalysisSummary?.framesSent ?? sourceFinding?.framesSent ?? 0;
    const frameTimestamps = currentAnalysisSummary?.frameTimestamps ?? sourceFinding?.frameTimestamps ?? [];
    const coverageText = isAiResult
      ? sourceFinding?.mediaType === "video" || currentAnalysisSummary?.mediaType === "video"
        ? `${framesSent} silent frame${framesSent === 1 ? "" : "s"} sent${frameTimestamps.length ? ` at ${frameTimestamps.map(formatEvidenceTimestamp).join(", ")}` : ""}`
        : `${framesSent || 1} resized image sent`
      : "No selected media was inspected";
    const resultMediaType = currentAnalysisSummary?.mediaType || sourceFinding?.mediaType;
    const resultDuration = currentAnalysisSummary?.durationSeconds ?? sourceFinding?.durationSeconds;
    const mediaLabel = currentResultAggregate ? "Saved findings" : resultMediaType === "video" ? `Video · ${formatDuration(resultDuration)}` : resultMediaType === "image" ? "Image" : resultSource === "mixed" ? "Saved findings" : "Demo scene";
    return `
      <div class="screen results-top">
        <button class="back-button" type="button" data-route="home">${icon("back")} Home</button>
        <div class="result-heading">
          <div><p class="eyebrow">${currentResultAggregate ? "Multiple saved scene checks" : `${zones[selectedZone]?.name || sourceFinding?.zone || "Scene"} · ${mediaLabel} · ${displayDate(sourceFinding || state.scans[0])}`}</p><h1>Review observations</h1></div>
          <span class="demo-chip">${isAiResult ? "AI-assisted" : ["mixed", "aggregate"].includes(resultSource) ? "Saved review" : "Demo"}</span>
        </div>
        <p class="lead">Use the evidence and uncertainty notes to verify each observation. Start with items that may need an in-person check.</p>
        <div class="result-summary">
          <div class="summary-number"><strong>${pendingCount}</strong><span>Awaiting caregiver review</span></div>
          <div class="summary-confidence"><strong>${unableToAssess ? "Unable" : "Human"}</strong><span>${unableToAssess ? "AI could not assess" : "Review required"}</span></div>
        </div>
        ${
          isAiResult
            ? `<div class="demo-banner">${icon("info")}<span><strong>AI-assisted, not guaranteed:</strong> ${escapeHtml(coverageText)}. ${unableToAssess ? escapeHtml(currentAnalysisSummary?.assessmentNote || "The AI service could not assess this scene.") : "Every observation can be incomplete or wrong and requires human verification."}</span></div>`
            : ["mixed", "aggregate"].includes(resultSource)
              ? `<div class="demo-banner">${icon("info")}<span><strong>Saved review:</strong> Each card identifies whether it came from the illustrated demo or AI-assisted analysis. All still require human review.</span></div>`
              : `<div class="demo-banner">${icon("info")}<span><strong>Representative output:</strong> these findings demonstrate the workflow and were not inferred from your selected image or video. Every finding requires human review.</span></div>`
        }
        ${isAiResult && currentAnalysisSummary?.source === "ai" && mediaPreview ? `<div class="capture-frame has-image ${resultMediaType === "video" ? "video-media" : ""}" style="min-height:220px">${renderMediaPreview()}<div class="capture-overlay"><span><i class="quality-dot"></i> Source media · not annotated</span><span>Temporary local preview</span></div></div><p class="small muted">This source preview remains only for the current review and is not saved in history.</p>` : ""}
        <div class="filter-scroll" aria-label="Filter observations">
          ${categories.map((category) => `<button class="filter-chip ${activeFilter === category ? "active" : ""}" type="button" data-action="filter" data-filter="${escapeHtml(category)}" aria-pressed="${activeFilter === category}">${escapeHtml(category)}</button>`).join("")}
        </div>
        <div class="findings-list">
          ${visible.length ? visible.map(renderFindingCard).join("") : unableToAssess ? `<div class="empty-state"><strong>Unable to assess this scene</strong><span>${escapeHtml(currentAnalysisSummary?.assessmentNote || "Try a clearer, wider scene with better lighting.")}</span></div>` : '<div class="empty-state"><strong>No observations in this category</strong><span>No AI observation is not proof that the scene is clear. Verify in person.</span></div>'}
        </div>
        <div class="context-note">${icon("info")}<span>Careview is not emergency monitoring. If someone may be in immediate danger, contact local emergency services or the person's care team.</span></div>
        <div class="scan-footer">
          <button class="primary-button" type="button" data-route="home">Finish review later</button>
          <button class="secondary-button" type="button" data-action="start-scan">Check another area</button>
        </div>
      </div>`;
  }

  function renderFindingCard(finding) {
    const iconName = finding.category === "Food" ? "food" : finding.category === "Medication" ? "medication" : "cleanliness";
    const bg = finding.category === "Food" ? "food-bg" : finding.category === "Medication" ? "med-bg" : finding.urgency === "now" ? "safety-bg" : "clean-bg";
    const safeStatus = ["pending", "confirmed", "resolved", "dismissed"].includes(finding.status) ? finding.status : "pending";
    const stateLabel = safeStatus === "pending" ? "Needs review" : safeStatus.charAt(0).toUpperCase() + safeStatus.slice(1);
    const sourceLabel = finding.source === "ai" ? "AI-assisted · verify" : "demo output";
    return `
      <button class="finding-card" type="button" data-action="open-finding" data-id="${escapeHtml(finding.id)}">
        <div class="finding-top">
          <span class="finding-icon ${bg}">${icon(iconName)}</span>
          <div class="finding-main">
            <div class="finding-meta"><span class="status-chip ${finding.urgency}">${escapeHtml(finding.urgencyLabel)}</span><span class="category-chip">${escapeHtml(finding.category)}</span></div>
            <h3>${escapeHtml(finding.title)}</h3>
            <p>${escapeHtml(finding.observed)}</p>
          </div>
        </div>
        <div class="finding-status-line"><span class="review-state ${safeStatus}">${stateLabel} · ${sourceLabel}</span><span class="finding-arrow">›</span></div>
      </button>`;
  }

  function renderHistoryScan(scan) {
    const count = Number.isInteger(scan.count) && scan.count >= 0 ? scan.count : 0;
    const mediaDescription = scan.mediaType === "video" ? `Video · ${formatDuration(scan.durationSeconds)}` : scan.mediaType === "image" ? "Image" : "Demo scene";
    const isAiScan = scan.source === "ai";
    const frameTimestamps = Array.isArray(scan.frameTimestamps) ? scan.frameTimestamps.filter(Number.isFinite).slice(0, MAX_VIDEO_FRAMES) : [];
    const coverage = isAiScan && scan.mediaType === "video"
      ? ` · ${Number.isInteger(scan.framesSent) ? scan.framesSent : frameTimestamps.length} silent frames sent${frameTimestamps.length ? ` at ${frameTimestamps.map(formatEvidenceTimestamp).join(", ")}` : ""}`
      : isAiScan && scan.mediaType === "image" ? " · resized image sent" : "";
    const outcome = scan.unableToAssess
      ? `Unable to assess${scan.assessmentNote ? ` · ${scan.assessmentNote}` : ""}`
      : isAiScan
        ? count ? `${count} AI-assisted observation${count === 1 ? "" : "s"} recorded · human review required` : "No AI observations returned · verify in person"
        : count ? `${count} prototype observation${count === 1 ? "" : "s"} recorded` : "no observations flagged";
    const reviewer = scan.createdBy ? ` · Added by ${displayName(scan.createdBy, "healthcare staff")}` : "";
    return `<div class="activity-row">
      <span class="timeline-icon ${count ? "clean-bg" : "food-bg"}">${icon(count ? "trend" : "check")}</span>
      <div class="activity-copy"><h3>${escapeHtml(scan.zoneLabel || scan.zone || "Scene")}</h3><p>${escapeHtml(mediaDescription + coverage)} · ${escapeHtml(outcome)}<br>${escapeHtml(displayDate(scan) + reviewer)}</p></div>
    </div>`;
  }

  function renderHistory() {
    const pending = state.findings.filter((finding) => finding.status === "pending").length;
    return `
      <div class="screen page-pad">
        ${patientContext()}
        <p class="eyebrow">${escapeHtml(displayName(selectedPatient, "Patient"))}'s visual baseline</p>
        <h1>Changes over time</h1>
        <p class="lead">Patterns become more useful as comparable scenes are reviewed. One image or video still counts as one scene check, not a habit.</p>

        <article class="trend-card" aria-labelledby="trend-title">
          <div class="row-between">
            <div class="metric-lockup"><strong id="trend-title">Illustrative observation trend</strong><span>Example only · not calculated from current data</span></div>
            <div class="metric-value"><strong>${pending}</strong><span>Need review</span></div>
          </div>
          <svg class="sparkline" viewBox="0 0 330 74" role="img" aria-label="Observation count varied between zero and three across six checks">
            <defs><linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#84c5ac" stop-opacity=".4"/><stop offset="1" stop-color="#84c5ac" stop-opacity="0"/></linearGradient></defs>
            <path class="spark-grid" d="M0 62h330M0 33h330M0 4h330"/>
            <path class="spark-area" d="M4 48 68 62 132 34 196 48 260 20 326 34V74H4Z"/>
            <path class="spark-path" d="M4 48 68 62 132 34 196 48 260 20 326 34"/>
            <g class="spark-dot"><circle cx="4" cy="48" r="4"/><circle cx="68" cy="62" r="4"/><circle cx="132" cy="34" r="4"/><circle cx="196" cy="48" r="4"/><circle cx="260" cy="20" r="4"/><circle cx="326" cy="34" r="4"/></g>
          </svg>
          <div class="baseline-callout"><strong>Demo-only visualization:</strong> A production trend must be calculated from consented, comparable scans and must distinguish “nothing flagged” from “unable to assess.”</div>
        </article>

        <div class="section-heading" style="margin-top:22px"><h2>Scene check history</h2><button class="section-link" type="button" data-action="export">Export</button></div>
        <div class="timeline">
          ${state.scans
            .slice(0, 8)
            .map(renderHistoryScan)
            .join("") || '<div class="empty-state"><strong>No scene checks yet</strong><span>Start a consented check to create shared patient history.</span></div>'}
        </div>
      </div>`;
  }

  function renderCare() {
    const installStatus = isStandaloneMode() ? "Running from the Home Screen" : "Open the Safari installation guide";
    const accountName = displayName(session.user);
    const accountEmail = typeof session.user?.email === "string" ? session.user.email : "Healthcare account";
    return `
      <div class="screen page-pad">
        ${selectedPatient ? patientContext() : ""}
        <p class="eyebrow">Account & care</p>
        <h1>${selectedPatient ? `${escapeHtml(displayName(selectedPatient, "Patient"))}'s care` : "Careview account"}</h1>
        <p class="lead">Review the active patient, workspace access, privacy preferences, and your signed-in account.</p>

        <article class="profile-card">
          <div class="person-lockup">
            <span class="person-avatar">${escapeHtml(initialsFor(session.user))}</span>
            <div><strong>${escapeHtml(accountName)}</strong><span>${escapeHtml(accountEmail)} · ${escapeHtml(String(session.user?.role || "healthcare user").replaceAll("_", " "))}</span></div>
          </div>
          ${selectedPatient ? `<div class="profile-consent"><div><strong>${escapeHtml(displayName(selectedPatient, "Patient"))}</strong><span>${escapeHtml(String(selectedPatient?.careLocation ?? selectedPatient?.care_location ?? "Care location not provided"))}</span></div><button class="quiet-button" type="button" data-route="patients">Switch</button></div>` : '<div class="profile-consent"><div><strong>No patient selected</strong><span>Select a patient before starting a scene check.</span></div><button class="quiet-button" type="button" data-route="patients">Select</button></div>'}
        </article>

        <div class="section-heading"><h2>Privacy controls</h2></div>
        <div class="setting-group">
          ${toggleRow("redact", "image", "Request privacy redaction", "Production preference only — editing is not active here", state.settings.redact)}
          ${toggleRow("retain", "lock", "Keep illustrated demo preview", "AI source media stays only through its current review, then is removed", state.settings.retain)}
          ${toggleRow("caregiverUpdates", "bell", "Request caregiver updates", "Production preference only — no messages are sent", state.settings.caregiverUpdates)}
        </div>

        <div class="section-heading"><h2>Access & data</h2></div>
        <div class="setting-group">
          <button class="setting-row" type="button" data-action="show-ios-install"><span class="setting-icon">${icon("share")}</span><span class="setting-copy"><strong>Install on iPhone</strong><span>${installStatus}</span></span><span class="setting-arrow">›</span></button>
          ${selectedPatient ? `<button class="setting-row" type="button" data-action="export"><span class="setting-icon">${icon("download")}</span><span class="setting-copy"><strong>Export current patient history</strong><span>Download the records currently visible to your account</span></span><span class="setting-arrow">›</span></button>` : ""}
          <button class="setting-row" type="button" data-action="clear-local"><span class="setting-icon safety-bg">${icon("trash")}</span><span class="setting-copy"><strong>Reset this device's preferences</strong><span>Clear UI preferences and the temporary media preview; shared records remain</span></span><span class="setting-arrow">›</span></button>
          <button class="setting-row" type="button" data-action="logout"><span class="setting-icon">${icon("logout")}</span><span class="setting-copy"><strong>Sign out</strong><span>End this healthcare session on this device</span></span><span class="setting-arrow">›</span></button>
        </div>

        ${isAdminUser() ? renderStaffAdministration() : ""}

        <div class="context-note" style="margin:0 0 18px">
          ${icon("shield")}<span>AI analysis uploads a resized photo or up to six silent video stills; raw video and audio stay local. Patient scenes and caregiver reviews are stored in the authenticated shared workspace, never in browser storage. Careview is not emergency monitoring.</span>
        </div>
      </div>`;
  }

  function renderStaffAdministration() {
    return `<section class="admin-panel" aria-labelledby="staff-title">
      <div class="section-heading"><h2 id="staff-title">Healthcare staff</h2><button class="section-link" type="button" data-action="refresh-users">Refresh</button></div>
      <div class="staff-list">
        ${staffLoading ? '<div class="loading-row" role="status"><span class="loading-spinner"></span>Loading staff…</div>' : staffUsers.length ? staffUsers.map((user) => `<div class="staff-row"><span class="person-avatar">${escapeHtml(initialsFor(user))}</span><span><strong>${escapeHtml(displayName(user))}</strong><small>${escapeHtml(String(user?.email || ""))} · ${escapeHtml(String(user?.role || "healthcare user").replaceAll("_", " "))}</small></span></div>`).join("") : '<div class="empty-state"><strong>No staff list loaded</strong><span>Refresh to view workspace users.</span></div>'}
      </div>
      <details class="add-panel" ${staffError || staffLoading ? "open" : ""}><summary>${icon("plus")} Add healthcare user</summary>
        <form class="stack-form" data-form="add-user">
          <label class="field-label" for="staff-name">Display name</label><input class="text-input" id="staff-name" name="displayName" autocomplete="off" minlength="2" maxlength="100" value="${escapeHtml(staffDraft.displayName)}" required />
          <label class="field-label" for="staff-email">Email</label><input class="text-input" id="staff-email" name="email" type="email" autocomplete="off" maxlength="254" value="${escapeHtml(staffDraft.email)}" required />
          <label class="field-label" for="staff-password">Temporary password</label><input class="text-input" id="staff-password" name="password" type="password" autocomplete="new-password" minlength="14" maxlength="200" required />
          <p class="field-help">Use 14–200 characters with uppercase, lowercase, a number, and a symbol.</p>
          <p class="form-error" role="alert" ${staffError ? "" : "hidden"}>${escapeHtml(staffError)}</p>
          <button class="primary-button" type="submit" ${staffLoading ? "disabled" : ""}>Add healthcare user</button>
        </form>
      </details>
    </section>`;
  }

  function toggleRow(key, iconName, title, description, value) {
    return `<button class="setting-row" type="button" data-action="toggle-setting" data-setting="${key}" aria-pressed="${value}">
      <span class="setting-icon">${icon(iconName)}</span><span class="setting-copy"><strong>${title}</strong><span>${description}</span></span><span class="toggle ${value ? "on" : ""}" aria-hidden="true"></span>
    </button>`;
  }

  function goTo(route, addHistory = true) {
    if (!session.authenticated) return;
    if (!selectedPatient && ["home", "scan", "analyzing", "results", "history"].includes(route)) route = "patients";
    if (analysisTimer || analysisController) cancelActiveAnalysis();
    const leavingCapture = currentRoute === "scan" && route !== "scan";
    const leavingInFlightCheck = currentRoute === "analyzing" && !["scan", "results"].includes(route);
    const leavingCompletedCheck = currentRoute === "results" && !["results", "scan"].includes(route);
    if (mediaLoading) cancelPendingMediaLoad();
    if (leavingCapture || leavingInFlightCheck || leavingCompletedCheck) clearMediaPreview();
    currentRoute = route;
    if (addHistory) window.history.pushState({ route, scanStep: route === "scan" ? scanStep : 0 }, "");
    render();
    if (route === "history" && selectedPatient) loadPatientScenes(selectedPatient, { quiet: true });
    if (route === "care" && isAdminUser() && !staffUsers.length) loadStaffUsers();
    window.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => app.focus({ preventScroll: true }), 0);
  }

  function startScan() {
    if (!selectedPatient?.id) {
      goTo("patients");
      showToast("Select a patient before starting a scene check");
      return;
    }
    selectedZone = null;
    scanStep = 1;
    currentFindings = [];
    currentAnalysisSummary = null;
    currentResultAggregate = false;
    activeFilter = "All";
    clearMediaPreview();
    goTo("scan");
  }

  function clearMediaPreview() {
    cancelPendingMediaLoad();
    document.querySelectorAll("video.capture-preview").forEach((video) => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    });
    if (mediaPreview) URL.revokeObjectURL(mediaPreview);
    mediaPreview = "";
    mediaMeta = null;
    mediaType = "";
    selectedMediaFile = null;
    isDemoMedia = false;
    analysisConsentConfirmed = false;
    mediaLoading = false;
    mediaError = "";
  }

  function cancelPendingMediaLoad() {
    mediaLoadToken += 1;
    if (pendingMediaLoader) {
      pendingMediaLoader.onload = null;
      pendingMediaLoader.onerror = null;
      pendingMediaLoader.onloadedmetadata = null;
      if (pendingMediaLoader.tagName === "VIDEO") {
        pendingMediaLoader.removeAttribute("src");
        pendingMediaLoader.load();
      } else {
        pendingMediaLoader.src = "";
      }
    }
    if (pendingMediaUrl) URL.revokeObjectURL(pendingMediaUrl);
    pendingMediaLoader = null;
    pendingMediaUrl = "";
    mediaLoading = false;
  }

  function reviewPending() {
    currentFindings = state.findings.filter((finding) => finding.status === "pending");
    currentAnalysisSummary = null;
    currentResultAggregate = true;
    selectedZone = null;
    activeFilter = "All";
    goTo("results");
  }

  function handleBack() {
    if (window.history.state?.route === "scan") {
      window.history.back();
      return;
    }
    if (scanStep === 1) return goTo("home");
    if (scanStep === 2) clearMediaPreview();
    scanStep -= 1;
    render();
  }

  function cancelActiveAnalysis() {
    if (analysisTimer) clearTimeout(analysisTimer);
    analysisTimer = null;
    analysisRunToken += 1;
    if (analysisController) analysisController.abort();
    analysisController = null;
    analysisPatientId = "";
    analysisProgressMessage = "";
  }

  function cancelAnalysisAndReturn() {
    cancelActiveAnalysis();
    currentRoute = "scan";
    scanStep = 3;
    mediaError = "Analysis cancelled. Confirm consent again when you are ready to retry.";
    window.history.replaceState({ route: "scan", scanStep: 3 }, "");
    render();
    window.scrollTo(0, 0);
    showToast("Analysis cancelled");
  }

  function startDemoAnalysis() {
    analysisProgressMessage = mediaType === "video" ? "No video frames are being inspected" : "The image is not being inspected";
    currentRoute = "analyzing";
    window.history.replaceState({ route: "analyzing", scanStep: 3 }, "");
    render();
    const messages = [
      analysisProgressMessage,
      `Preparing representative ${zones[selectedZone].name.toLowerCase()} examples`,
      "Building caregiver review cards",
    ];
    let index = 0;
    const status = () => document.querySelector("#analysis-status span");
    const tick = () => {
      index += 1;
      if (index < messages.length && status()) {
        status().textContent = messages[index];
        analysisTimer = setTimeout(tick, 650);
      } else {
        analysisTimer = setTimeout(() => {
          analysisTimer = null;
          completeAnalysis();
        }, 450);
      }
    };
    analysisTimer = setTimeout(tick, 650);
  }

  async function startAnalysis() {
    mediaError = "";
    if (isDemoMedia) {
      startDemoAnalysis();
      return;
    }
    if (!selectedMediaFile) {
      mediaError = "Choose an image or video before starting AI analysis.";
      render();
      return;
    }
    if (!selectedPatient?.id) {
      mediaError = "Select a patient before starting AI analysis.";
      goTo("patients");
      return;
    }
    if (!analysisConsentConfirmed) {
      mediaError = "Confirm consent and the privacy review before uploading media for AI analysis.";
      render();
      return;
    }
    analysisConsentConfirmed = false;
    cancelActiveAnalysis();
    const runToken = analysisRunToken;
    analysisPatientId = String(selectedPatient.id);
    const controller = new AbortController();
    analysisController = controller;
    analysisProgressMessage = mediaType === "video" ? "Preparing silent video frames on this device" : "Preparing a resized image on this device";
    currentRoute = "analyzing";
    window.history.replaceState({ route: "analyzing", scanStep: 3 }, "");
    render();
    let timedOut = false;
    let preparedMedia = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ANALYSIS_TIMEOUT_MS);
    try {
      preparedMedia = mediaType === "video"
        ? await prepareVideoForAnalysis(selectedMediaFile, controller.signal, runToken)
        : await prepareImageForAnalysis(selectedMediaFile, controller.signal, runToken);
      ensureActiveAnalysis(runToken, controller.signal);
      const result = await requestAiAnalysis(preparedMedia, controller.signal, runToken);
      ensureActiveAnalysis(runToken, controller.signal);
      completeRealAnalysis(result, preparedMedia, runToken);
    } catch (error) {
      if (runToken !== analysisRunToken) return;
      const message = userFacingAnalysisError(error, timedOut);
      analysisController = null;
      analysisProgressMessage = "";
      currentRoute = "scan";
      scanStep = 3;
      mediaError = message;
      window.history.replaceState({ route: "scan", scanStep: 3 }, "");
      render();
      window.scrollTo(0, 0);
      showToast(message);
    } finally {
      clearTimeout(timeout);
      if (preparedMedia) preparedMedia.frames.forEach((frame) => { frame.dataUrl = ""; });
      if (analysisController === controller) analysisController = null;
      if (runToken === analysisRunToken) analysisPatientId = "";
    }
  }

  function openFinding(id) {
    const finding = state.findings.find((item) => item.id === id) || currentFindings.find((item) => item.id === id);
    if (!finding) return;
    activeFindingId = id;
    reviewDraftStatus = ["pending", "confirmed", "resolved", "dismissed"].includes(finding.status) ? finding.status : "pending";
    const isAiFinding = finding.source === "ai";
    const safeUrgency = ["now", "soon", "monitor"].includes(finding.urgency) ? finding.urgency : "soon";
    const framesSent = Number.isInteger(finding.framesSent) ? finding.framesSent : 0;
    const timestamps = Array.isArray(finding.frameTimestamps) ? finding.frameTimestamps.filter(Number.isFinite).slice(0, MAX_VIDEO_FRAMES) : [];
    const evidenceFrames = Array.isArray(finding.evidenceFrameNumbers) ? finding.evidenceFrameNumbers.filter((number) => Number.isInteger(number) && number >= 1 && number <= MAX_VIDEO_FRAMES).slice(0, MAX_VIDEO_FRAMES) : [];
    const evidenceTimestamps = Array.isArray(finding.evidenceTimestamps) ? finding.evidenceTimestamps.filter(Number.isFinite).slice(0, MAX_VIDEO_FRAMES) : [];
    const hasCurrentSourcePreview = Boolean(isAiFinding && currentAnalysisSummary?.source === "ai" && mediaPreview);
    const coverage = finding.mediaType === "video"
      ? `Video ${formatDuration(finding.durationSeconds)} · ${framesSent} silent frame${framesSent === 1 ? "" : "s"} sent${timestamps.length ? ` at ${timestamps.map(formatEvidenceTimestamp).join(", ")}` : ""}${isAiFinding && evidenceFrames.length ? ` · finding cites frame${evidenceFrames.length === 1 ? "" : "s"} ${evidenceFrames.join(", ")}${evidenceTimestamps.length ? ` at ${evidenceTimestamps.map(formatEvidenceTimestamp).join(", ")}` : ""}` : ""}`
      : finding.mediaType === "image" ? `${isAiFinding ? "One resized image sent · finding cites frame 1" : "Image · not inspected"}` : "Illustrative demo evidence";
    const sourcePreview = hasCurrentSourcePreview
      ? `<div class="capture-frame has-image ${finding.mediaType === "video" ? "video-media" : ""}" style="min-height:210px">${renderMediaPreview()}<div class="capture-overlay"><span><i class="quality-dot"></i> Source media · not annotated</span><span>Temporary local preview</span></div></div>`
      : `<div class="evidence-box" role="img" aria-label="${isAiFinding ? "Source media is not retained with this finding" : "Illustrative evidence region for this prototype"}"><span class="evidence-label">${isAiFinding ? "Source media unavailable after this review" : "Illustrative evidence area"}</span></div>`;
    sheetReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheet.innerHTML = `
      <div class="sheet-grabber" aria-hidden="true"></div>
      <button class="sheet-close" type="button" data-action="close-sheet" aria-label="Close finding details">×</button>
      <div class="sheet-heading">
        <div class="finding-meta"><span class="status-chip ${safeUrgency}">${escapeHtml(finding.urgencyLabel)}</span><span class="category-chip">${escapeHtml(finding.category)}</span><span class="confidence-chip">${isAiFinding ? "AI-assisted · no confidence score" : "Confidence not calculated"}</span></div>
        <h2 id="sheet-title">${escapeHtml(finding.title)}</h2>
        <p class="small muted">${escapeHtml(finding.zone)} · ${escapeHtml(coverage)} · ${escapeHtml(displayDate(finding))}</p>
      </div>
      ${sourcePreview}
      ${hasCurrentSourcePreview && finding.mediaType === "video" && evidenceTimestamps.length ? `<div class="filter-scroll" aria-label="Finding evidence timestamps">${evidenceTimestamps.map((time, index) => `<button class="filter-chip" type="button" data-action="seek-evidence" data-time="${time}">Frame ${evidenceFrames[index] || index + 1} · ${formatEvidenceTimestamp(time)}</button>`).join("")}</div>` : ""}
      <div class="detail-section"><strong>Visible observation</strong><p>${escapeHtml(finding.observed)}</p></div>
      <div class="detail-section"><strong>Why it may matter</strong><p>${escapeHtml(finding.meaning)}</p></div>
      <div class="detail-section"><strong>Suggested caregiver check</strong><p>${escapeHtml(finding.action)}</p></div>
      <div class="detail-section"><strong>Uncertainty</strong><p>${escapeHtml(finding.limitation)}</p></div>
      <label class="note-label" for="caregiver-note">Caregiver note</label>
      <textarea class="note-input" id="caregiver-note" placeholder="Add what you verified in person…">${escapeHtml(finding.note || "")}</textarea>
      ${finding.reviewedBy ? `<p class="small muted">Last reviewed by ${escapeHtml(displayName(finding.reviewedBy, "healthcare staff"))}${finding.updatedAt ? ` · ${escapeHtml(displayDate({ timestamp: finding.updatedAt }))}` : ""}</p>` : ""}
      <p class="small muted">Use Confirm only after checking the source preview or verifying the condition in person. A saved AI card without source media is not sufficient evidence.</p>
      <div class="review-actions" role="group" aria-label="Review status">
        <button class="review-action ${finding.status === "confirmed" ? "active" : ""}" type="button" data-action="set-review" data-status="confirmed" aria-pressed="${finding.status === "confirmed"}">Confirm in person</button>
        <button class="review-action ${finding.status === "resolved" ? "active" : ""}" type="button" data-action="set-review" data-status="resolved" aria-pressed="${finding.status === "resolved"}">Resolved</button>
        <button class="review-action ${finding.status === "dismissed" ? "active" : ""}" type="button" data-action="set-review" data-status="dismissed" aria-pressed="${finding.status === "dismissed"}">Not present</button>
      </div>
      <button class="primary-button sheet-save" type="button" data-action="save-review">Save review</button>`;
    sheet.hidden = false;
    sheetBackdrop.hidden = false;
    appShell.inert = true;
    document.body.style.overflow = "hidden";
    setTimeout(() => sheet.querySelector(".sheet-close").focus(), 0);
  }

  function openIosInstallGuide() {
    const installed = isStandaloneMode();
    const secure = window.isSecureContext;
    sheetReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheet.innerHTML = `
      <div class="sheet-grabber" aria-hidden="true"></div>
      <button class="sheet-close" type="button" data-action="close-sheet" aria-label="Close iPhone installation guide">×</button>
      <div class="sheet-heading install-sheet-heading">
        <span class="install-status ${installed ? "installed" : secure ? "ready" : "testing"}">${installed ? "Installed" : secure ? "Ready to install" : "Testing address"}</span>
        <h2 id="sheet-title">Use Careview like an iPhone app</h2>
        <p class="small muted">Safari controls Home Screen installation, so Careview cannot open the install sheet for you.</p>
      </div>
      <ol class="install-steps">
        <li class="install-step"><span class="install-number">1</span><div><strong>Open the secure HTTPS address in Safari</strong><p>Use the deployed Careview link, not a temporary local-network HTTP address.</p></div></li>
        <li class="install-step"><span class="install-number">2</span><div><strong>Tap Share or More</strong><p>Choose <b>Add to Home Screen</b>.</p></div></li>
        <li class="install-step"><span class="install-number">3</span><div><strong>Turn on Open as Web App</strong><p>Tap <b>Add</b>, then launch Careview from its new Home Screen icon.</p></div></li>
      </ol>
      ${
        secure
          ? '<div class="context-note install-note">' + icon("info") + "<span>This address is a secure context. Offline shell support becomes available after a successful service-worker install.</span></div>"
          : '<div class="context-note install-note warning">' + icon("info") + "<span>This HTTP address is suitable only for same-Wi-Fi testing. Use HTTPS before installing or handling real care-recipient information.</span></div>"
      }
      <button class="primary-button sheet-save" type="button" data-action="close-sheet">Done</button>`;
    sheet.hidden = false;
    sheetBackdrop.hidden = false;
    appShell.inert = true;
    document.body.style.overflow = "hidden";
    setTimeout(() => sheet.querySelector(".sheet-close").focus(), 0);
  }

  function closeSheet(restoreFocus = true) {
    if (sheet.hidden) return;
    sheet.hidden = true;
    sheetBackdrop.hidden = true;
    appShell.inert = false;
    document.body.style.overflow = "";
    if (restoreFocus) {
      if (sheetReturnFocus?.isConnected) sheetReturnFocus.focus();
      else if (activeFindingId) document.querySelector(`[data-id="${activeFindingId}"]`)?.focus();
    }
    sheetReturnFocus = null;
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("show");
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function renderAndFocus(selector) {
    render();
    requestAnimationFrame(() => document.querySelector(selector)?.focus({ preventScroll: true }));
  }

  async function loadStaffUsers() {
    if (!isAdminUser() || staffLoading) return;
    staffLoading = true;
    staffError = "";
    render();
    try {
      const payload = await apiFetch("/api/users");
      staffUsers = Array.isArray(payload.users) ? payload.users : [];
    } catch (error) {
      staffError = error.message;
    } finally {
      staffLoading = false;
      render();
    }
  }

  async function signOut() {
    try {
      await apiFetch("/api/logout", { method: "POST", body: JSON.stringify({}) });
    } catch (error) {
      if (error.status !== 401) showToast("Sign-out failed. You are still signed in.");
      return;
    }
    transitionToSignedOut();
  }

  async function saveFindingReview() {
    const finding = state.findings.find((item) => item.id === activeFindingId) || currentFindings.find((item) => item.id === activeFindingId);
    if (!finding) return;
    const note = sheet.querySelector("#caregiver-note")?.value.trim() || "";
    const previousStatus = finding.status;
    const previousNote = finding.note;
    if (finding.source === "demo") {
      finding.status = reviewDraftStatus;
      finding.note = note;
      closeSheet(false);
      render();
      showToast("Demo review updated for this screen only");
      return;
    }
    if (!selectedPatient?.id) return;
    const saveButton = sheet.querySelector('[data-action="save-review"]');
    if (saveButton) saveButton.disabled = true;
    try {
      const payload = await apiFetch(`/api/patients/${encodeURIComponent(selectedPatient.id)}/findings/${encodeURIComponent(finding.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: reviewDraftStatus, note, version: Number.isInteger(finding.version) ? finding.version : 0 }),
      });
      const saved = payload.finding ?? payload;
      finding.status = ["pending", "confirmed", "resolved", "dismissed"].includes(saved?.status) ? saved.status : reviewDraftStatus;
      finding.note = typeof saved?.note === "string" ? saved.note : note;
      finding.version = Number.isInteger(saved?.version) ? saved.version : finding.version + 1;
      finding.updatedAt = saved?.updatedAt ?? saved?.updated_at ?? finding.updatedAt;
      finding.reviewedBy = saved?.reviewedBy ?? saved?.reviewed_by ?? finding.reviewedBy;
      closeSheet(false);
      if (currentRoute === "results") render();
      showToast("Review saved to the shared patient record");
    } catch (error) {
      finding.status = previousStatus;
      finding.note = previousNote;
      if (error.status === 409) {
        closeSheet(false);
        await loadPatientScenes(selectedPatient, { quiet: true });
        showToast("Another healthcare user updated this finding. The latest record is now shown.");
      } else {
        if (saveButton) saveButton.disabled = false;
        showToast(error.message);
      }
    }
  }

  function exportData() {
    if (!selectedPatient) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      notice: "Authorized patient export. AI findings require caregiver verification.",
      patient: selectedPatient,
      scans: state.scans,
      findings: state.findings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "careview-patient-history.json";
    link.click();
    URL.revokeObjectURL(url);
    showToast("Current patient history exported");
  }

  function displayDate(record) {
    if (!record?.timestamp) return record?.date || "Date unavailable";
    const value = new Date(record.timestamp);
    const elapsed = Date.now() - value.getTime();
    if (elapsed >= 0 && elapsed < 60_000) return "Just now";
    if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
    if (value.toDateString() === new Date().toDateString()) {
      return value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    return value.toLocaleDateString([], { month: "short", day: "numeric", year: value.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  document.addEventListener("click", (event) => {
    const routeButton = event.target.closest("[data-route]");
    if (routeButton) {
      goTo(routeButton.dataset.route);
      return;
    }

    const control = event.target.closest("[data-action]");
    if (!control) return;
    const action = control.dataset.action;

    if (action === "select-patient") {
      const id = String(control.dataset.patientId || "");
      const patient = [...patientSuggestions, ...patientDirectory].find((item) => String(item?.id || "") === id);
      if (patient) selectPatient(patient);
    }
    if (action === "start-scan") startScan();
    if (action === "review-pending") reviewPending();
    if (action === "scan-back") handleBack();
    if (action === "select-zone") {
      selectedZone = control.dataset.zone;
      renderAndFocus(`[data-zone="${selectedZone}"]`);
    }
    if (action === "scan-next") {
      scanStep = Math.min(3, scanStep + 1);
      window.history.pushState({ route: "scan", scanStep }, "");
      render();
      window.scrollTo(0, 0);
    }
    if (action === "use-demo") {
      clearMediaPreview();
      mediaType = "video";
      mediaMeta = { width: 1280, height: 720, duration: 18, sampleCount: 6, sampleTimes: [3, 5, 8, 10, 13, 15] };
      isDemoMedia = true;
      render();
      showToast("Demo video added — no media was uploaded");
    }
    if (action === "cancel-analysis") cancelAnalysisAndReturn();
    if (action === "analyze") startAnalysis();
    if (action === "filter") {
      activeFilter = control.dataset.filter;
      renderAndFocus(`[data-filter="${activeFilter}"]`);
    }
    if (action === "open-finding") openFinding(control.dataset.id);
    if (action === "show-ios-install") openIosInstallGuide();
    if (action === "dismiss-ios-install") {
      state.settings.iosInstallDismissed = true;
      savePreferences();
      render();
      showToast("iPhone install tip hidden — it remains available under Care");
    }
    if (action === "close-sheet") closeSheet();
    if (action === "set-review") {
      reviewDraftStatus = control.dataset.status;
      sheet.querySelectorAll(".review-action").forEach((item) => {
        const active = item.dataset.status === reviewDraftStatus;
        item.classList.toggle("active", active);
        item.setAttribute("aria-pressed", String(active));
      });
    }
    if (action === "seek-evidence") {
      const video = sheet.querySelector("video.capture-preview");
      const timestamp = Number(control.dataset.time);
      if (video && Number.isFinite(timestamp)) {
        video.currentTime = timestamp;
        video.focus();
      }
    }
    if (action === "save-review") saveFindingReview();
    if (action === "toggle-setting") {
      const key = control.dataset.setting;
      state.settings[key] = !state.settings[key];
      savePreferences();
      renderAndFocus(`[data-setting="${key}"]`);
      showToast(`${control.querySelector("strong").textContent} ${state.settings[key] ? "on" : "off"}`);
    }
    if (action === "export") exportData();
    if (action === "logout") signOut();
    if (action === "refresh-users") loadStaffUsers();
    if (action === "clear-local") {
      if (window.confirm("Reset Careview UI preferences and remove the temporary media preview from this device? Shared patient records will not be deleted.")) {
        clearMediaPreview();
        state.settings = { ...defaultPreferences.settings };
        preferences.settings = state.settings;
        savePreferences();
        render();
        showToast("This device's Careview preferences were reset");
      }
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    const formData = new FormData(form);
    const kind = form.dataset.form;

    if (kind === "login" || kind === "setup") {
      if (authBusy) return;
      authDraft.email = String(formData.get("email") || "").trim();
      authDraft.workspaceName = kind === "setup" ? String(formData.get("workspaceName") || "").trim() : "";
      authDraft.displayName = kind === "setup" ? String(formData.get("displayName") || "").trim() : "";
      authBusy = true;
      authError = "";
      render();
      const body = {
        email: String(formData.get("email") || "").trim(),
        password: String(formData.get("password") || ""),
      };
      if (kind === "setup") {
        body.workspaceName = String(formData.get("workspaceName") || "").trim();
        body.displayName = String(formData.get("displayName") || "").trim();
      }
      try {
        await apiFetch(kind === "setup" ? "/api/setup" : "/api/login", { method: "POST", body: JSON.stringify(body) });
        authBusy = false;
        authDraft = { workspaceName: "", displayName: "", email: "" };
        await bootstrapSession();
      } catch (error) {
        authBusy = false;
        authError = kind === "login" ? "Email or password was not accepted." : error.message;
        render();
        requestAnimationFrame(() => document.querySelector("#auth-email")?.focus());
      }
      return;
    }

    if (kind === "add-patient") {
      if (patientMutationBusy) return;
      patientDraft = {
        displayName: String(formData.get("displayName") || "").trim(),
        careLocation: String(formData.get("careLocation") || "").trim(),
      };
      patientMutationBusy = true;
      patientError = "";
      render();
      try {
        const payload = await apiFetch("/api/patients", {
          method: "POST",
          body: JSON.stringify({
            displayName: patientDraft.displayName,
            careLocation: patientDraft.careLocation,
          }),
        });
        const patient = payload.patient ?? payload;
        patientDirectory = [patient, ...patientDirectory.filter((item) => String(item?.id) !== String(patient?.id))];
        patientMutationBusy = false;
        patientDraft = { displayName: "", careLocation: "" };
        await selectPatient(patient);
      } catch (error) {
        patientMutationBusy = false;
        patientError = error.message;
        render();
      }
      return;
    }

    if (kind === "add-user" && isAdminUser()) {
      staffDraft = {
        displayName: String(formData.get("displayName") || "").trim(),
        email: String(formData.get("email") || "").trim(),
      };
      staffLoading = true;
      staffError = "";
      render();
      try {
        await apiFetch("/api/users", {
          method: "POST",
          body: JSON.stringify({
            displayName: staffDraft.displayName,
            email: staffDraft.email,
            password: String(formData.get("password") || ""),
          }),
        });
        staffLoading = false;
        staffDraft = { displayName: "", email: "" };
        await loadStaffUsers();
        showToast("Healthcare user added");
      } catch (error) {
        staffLoading = false;
        staffError = error.message;
        render();
      }
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id !== "patient-search") return;
    patientQuery = event.target.value.slice(0, 100);
    patientSearchOpen = Boolean(patientQuery.trim());
    patientActiveIndex = -1;
    clearTimeout(patientSearchTimer);
    if (!patientSearchOpen) {
      patientSuggestions = patientDirectory;
      render();
      restorePatientSearchFocus();
      return;
    }
    patientSearchTimer = setTimeout(() => loadPatientDirectory(patientQuery.trim(), { restoreSearchFocus: true }), 250);
  });

  document.addEventListener("focusin", (event) => {
    if (event.target.id !== "patient-search" || !patientQuery.trim()) return;
    patientSearchOpen = true;
    document.querySelector("#patient-suggestions")?.removeAttribute("hidden");
    event.target.setAttribute("aria-expanded", "true");
  });

  document.addEventListener("keydown", (event) => {
    if (event.target.id !== "patient-search" || !patientSearchOpen) return;
    const options = [...document.querySelectorAll("#patient-suggestions .patient-option")];
    if (event.key === "Escape") {
      patientSearchOpen = false;
      patientActiveIndex = -1;
      event.target.setAttribute("aria-expanded", "false");
      document.querySelector("#patient-suggestions")?.setAttribute("hidden", "");
      event.preventDefault();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key) || !options.length) return;
    event.preventDefault();
    if (event.key === "Enter") {
      options[Math.max(0, patientActiveIndex)].click();
      return;
    }
    if (event.key === "ArrowDown") patientActiveIndex = (patientActiveIndex + 1) % options.length;
    if (event.key === "ArrowUp") patientActiveIndex = (patientActiveIndex - 1 + options.length) % options.length;
    options.forEach((option, index) => option.setAttribute("aria-selected", String(index === patientActiveIndex)));
    event.target.setAttribute("aria-activedescendant", options[patientActiveIndex].id);
    options[patientActiveIndex].scrollIntoView({ block: "nearest" });
  });

  document.addEventListener("change", (event) => {
    if (event.target.id === "analysis-consent") {
      analysisConsentConfirmed = event.target.checked;
      mediaError = "";
      const analyzeButton = document.querySelector('[data-action="analyze"]');
      if (analyzeButton) analyzeButton.disabled = !analysisConsentConfirmed;
      document.querySelector("#analysis-error")?.setAttribute("hidden", "");
      return;
    }
    if (!event.target.classList.contains("scene-media-input")) return;
    const file = event.target.files?.[0];
    if (!file) return;
    analysisConsentConfirmed = false;
    const loadToken = ++mediaLoadToken;
    const extension = file.name.toLowerCase();
    const isImage = file.type.startsWith("image/") || /\.(avif|gif|heic|heif|jpe?g|png|webp)$/i.test(extension);
    const isVideo = file.type.startsWith("video/") || /\.(m4v|mov|mp4|ogv|webm)$/i.test(extension);

    const rejectSelection = (message, candidateUrl = "") => {
      if (candidateUrl && pendingMediaUrl === candidateUrl) {
        if (pendingMediaLoader) {
          pendingMediaLoader.onload = null;
          pendingMediaLoader.onerror = null;
          pendingMediaLoader.onloadedmetadata = null;
          if (pendingMediaLoader.tagName === "VIDEO") {
            pendingMediaLoader.removeAttribute("src");
            pendingMediaLoader.load();
          } else {
            pendingMediaLoader.src = "";
          }
        }
        pendingMediaLoader = null;
        pendingMediaUrl = "";
      }
      if (candidateUrl) URL.revokeObjectURL(candidateUrl);
      if (loadToken !== mediaLoadToken) return;
      mediaLoading = false;
      mediaError = message;
      render();
      showToast(message);
    };

    if (!isImage && !isVideo) {
      rejectSelection("Choose a supported image or video file");
      return;
    }

    const sizeLimit = isVideo ? 100 * 1024 * 1024 : 12 * 1024 * 1024;
    if (file.size > sizeLimit) {
      rejectSelection(isVideo ? "Choose a video smaller than 100 MB" : "Choose an image smaller than 12 MB");
      return;
    }

    mediaLoading = true;
    mediaError = "";
    render();
    const candidateUrl = URL.createObjectURL(file);
    pendingMediaUrl = candidateUrl;

    if (isVideo) {
      const video = document.createElement("video");
      const releaseLoader = () => {
        video.onloadedmetadata = null;
        video.onerror = null;
        video.removeAttribute("src");
        video.load();
        if (pendingMediaLoader === video) pendingMediaLoader = null;
      };
      pendingMediaLoader = video;
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      video.onloadedmetadata = () => {
        if (loadToken !== mediaLoadToken) {
          releaseLoader();
          URL.revokeObjectURL(candidateUrl);
          return;
        }
        const duration = video.duration;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!Number.isFinite(duration) || duration < 1 || duration > 30) {
          releaseLoader();
          rejectSelection("Choose a video between 1 and 30 seconds", candidateUrl);
          return;
        }
        if (!width || !height || Math.min(width, height) < 480) {
          releaseLoader();
          rejectSelection("Choose a video at least 480 pixels on its shortest side", candidateUrl);
          return;
        }
        if (Math.max(width, height) > 3840) {
          releaseLoader();
          rejectSelection("Choose a video no larger than 4K (3840 pixels)", candidateUrl);
          return;
        }
        const sampleCount = Math.min(MAX_VIDEO_FRAMES, Math.max(3, Math.ceil(duration / 3)));
        const sampleTimes = Array.from({ length: sampleCount }, (_item, index) =>
          Number((((index + 1) * duration) / (sampleCount + 1)).toFixed(1)),
        );
        releaseLoader();
        pendingMediaUrl = "";
        clearMediaPreview();
        mediaPreview = candidateUrl;
        mediaMeta = { width, height, duration, sampleCount, sampleTimes, size: file.size, mime: file.type || "video" };
        mediaType = "video";
        selectedMediaFile = file;
        isDemoMedia = false;
        render();
        requestAnimationFrame(() => document.querySelector('[data-action="scan-next"]')?.focus({ preventScroll: true }));
        showToast("Video added for private preview");
      };
      video.onerror = () => {
        releaseLoader();
        rejectSelection("That video could not be decoded in this browser", candidateUrl);
      };
      video.src = candidateUrl;
      return;
    }

    const image = new Image();
    pendingMediaLoader = image;
    image.onload = () => {
      if (loadToken !== mediaLoadToken) {
        URL.revokeObjectURL(candidateUrl);
        return;
      }
      if (Math.min(image.naturalWidth, image.naturalHeight) < 480) {
        rejectSelection("Choose an image at least 480 pixels on its shortest side", candidateUrl);
        return;
      }
      image.onload = null;
      image.onerror = null;
      pendingMediaLoader = null;
      pendingMediaUrl = "";
      clearMediaPreview();
      mediaPreview = candidateUrl;
      mediaMeta = { width: image.naturalWidth, height: image.naturalHeight, size: file.size, mime: file.type || "image" };
      mediaType = "image";
      selectedMediaFile = file;
      isDemoMedia = false;
      render();
      requestAnimationFrame(() => document.querySelector('[data-action="scan-next"]')?.focus({ preventScroll: true }));
      showToast("Image added for private preview");
    };
    image.onerror = () => {
      rejectSelection("That image could not be decoded in this browser", candidateUrl);
    };
    image.src = candidateUrl;
  });

  sheetBackdrop.addEventListener("click", () => closeSheet());
  window.addEventListener("popstate", (event) => {
    if (analysisTimer || analysisController) cancelActiveAnalysis();
    const historyState = event.state || { route: "home", scanStep: 1 };
    let nextRoute = historyState.route === "analyzing" ? "scan" : historyState.route;
    if (!session.authenticated) nextRoute = "patients";
    if (!selectedPatient && ["home", "scan", "analyzing", "results", "history"].includes(nextRoute)) nextRoute = "patients";
    const nextStep = historyState.route === "analyzing" ? 3 : historyState.scanStep || 1;
    const leavingCapture = currentRoute === "scan" && (nextRoute !== "scan" || (scanStep === 2 && nextStep === 1));
    const leavingInFlightCheck = currentRoute === "analyzing" && !["scan", "results"].includes(nextRoute);
    const leavingCompletedCheck = currentRoute === "results" && !["results", "scan"].includes(nextRoute);
    if (currentRoute === "scan" && scanStep === 3 && nextRoute === "scan" && nextStep === 2) {
      analysisConsentConfirmed = false;
      mediaError = "";
    }
    if (mediaLoading) cancelPendingMediaLoad();
    if (leavingCapture || leavingInFlightCheck || leavingCompletedCheck) clearMediaPreview();
    currentRoute = nextRoute;
    scanStep = nextStep;
    render();
    window.scrollTo(0, 0);
  });
  window.addEventListener("pagehide", () => {
    cancelActiveAnalysis();
    clearMediaPreview();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    if (currentRoute === "analyzing") currentRoute = "scan";
    if (currentRoute === "scan" && scanStep > 1 && !mediaPreview && !isDemoMedia) scanStep = 2;
    bootstrapSession();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") revalidateSession();
  });
  document.addEventListener("keydown", (event) => {
    if (sheet.hidden) return;
    if (event.key === "Escape") {
      closeSheet();
      return;
    }
    if (event.key === "Tab") {
      const focusable = [...sheet.querySelectorAll('button:not([disabled]), textarea, input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }

  window.history.replaceState({ route: "patients", scanStep: 0 }, "");
  bootstrapSession();
})();
