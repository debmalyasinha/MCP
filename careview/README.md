# Careview AI mobile prototype

Careview is an installable, mobile-first web app for caregivers who review consented images and short videos of an older adult's kitchen, fridge/freezer, medication area, or living space. It can send carefully prepared still images to an OpenAI vision model and present objective, caregiver-reviewable observations.

Careview is not a monitoring or emergency system. It does not diagnose a condition, determine nutrition or medication adherence, judge neglect or care quality, or prove a habit from one scene. If someone may be in immediate danger, check in person and contact local emergency services.

## What the current build does

- Captures or selects an image or a 1-30 second video on iPhone.
- Validates media size, dimensions, duration, and browser decodability.
- Requires a fresh consent and privacy confirmation for every AI analysis.
- Converts an image to one resized JPEG before upload.
- Samples up to six timestamped JPEG frames from a video in the browser. The raw video and its audio are not uploaded.
- Calls a same-origin Python backend, which keeps the OpenAI API key off the phone.
- Uses a strict structured response and validates it again before showing it.
- Separates assessed, unable-to-assess, refused, incomplete, and service-error states.
- Lets a caregiver confirm, correct, dismiss, annotate, and resolve observations.
- Keeps the illustrated demo path available without making an API call.

One image or one video counts as one scene check. Multiple frames from the same video are not separate observations.

## Run the AI app on this Windows computer

The server uses Python's standard library, so no Python package installation is required. An OpenAI API key with available API billing is required for real AI analysis. Never put that key in `app.js`, a URL, or the iPhone.

Store the API key once as the `careview` secret in the password-protected
`CareviewVault`. Then start the server from PowerShell in `C:\Work` with:

```powershell
.\careview\scripts\start-careview.ps1
```

The launcher retrieves the saved secret, exposes it only to the server process,
and removes it from the PowerShell process when the server stops. The vault may
prompt for its unlock password, but the OpenAI API key does not need to be
entered again. Open [http://127.0.0.1:4173](http://127.0.0.1:4173) and stop the
server with `Ctrl+C`.

Under the hood, the launcher sets `OPENAI_API_KEY` only for the process and runs
`python careview\server.py`; use the launcher so the key is never typed or stored
in the repository.

`OPENAI_MODEL` is optional; the server defaults to `gpt-5.6-terra`.

## Open it on an iPhone over the same Wi-Fi

For test media only, bind the server to the local network:

```powershell
cd C:\Work
.\careview\scripts\start-careview.ps1 -Lan
```

Find the computer's Wi-Fi IPv4 address with `ipconfig`. Connect both devices to the same trusted, non-guest Wi-Fi and open this form of address in iPhone Safari:

```text
http://YOUR-WINDOWS-IP:4173/
```

For the current computer that was `http://192.168.2.221:4173/`; it can change after reconnecting. Do not use the public IP address. If the page times out, set the trusted home Wi-Fi profile to Private and allow Python through Windows Defender Firewall on Private networks only. Keep the server window open and the computer awake.

This LAN setup uses plain HTTP. It is only for short-lived interface and integration testing with non-sensitive media: uploaded frames are not encrypted in transit, and iPhone service-worker/install behavior requires a secure context. Do not use it for real resident imagery, medication information, or personal data.

## Install on an iPhone

Deploy Careview and its API together at an authenticated **HTTPS** origin. In Safari:

1. Tap **Share** (or **More**).
2. Tap **Add to Home Screen**.
3. Turn on **Open as Web App**.
4. Tap **Add**.

Adding the PWA to the Home Screen does not publish it in the App Store. A native App Store release is a separate path requiring Apple signing, device testing, privacy disclosures, review, and a production backend.

## Media and analysis limits

- Images: up to 12 MB and at least 480 pixels on the shortest side.
- Videos: up to 100 MB, 1-30 seconds, at least 480 pixels on the shortest side, and no larger than 4K.
- AI input: one resized JPEG for an image or at most six sampled JPEG frames for a video.
- Video audio is never analyzed or sent, and a sampled video can miss brief or hidden details.
- HEIC/HEIF images and MOV/HEVC videos depend on the iPhone/browser being able to decode them locally.

The browser canvas removes file metadata and excludes audio while creating AI input frames. It does **not** automatically detect or redact faces, screens, mail, addresses, financial information, or prescription identifiers. The caregiver must review the whole image or clip and avoid uploading media containing people or private identifiers.

## Privacy and safety boundary

The backend sends the prepared frames to the OpenAI Responses API with `store: false`. OpenAI API inputs and outputs are not used for model training by default, but default abuse-monitoring logs may retain customer content for up to 30 days unless the organization has approved Modified Abuse Monitoring or Zero Data Retention controls.

The selected file remains in browser memory for preview and human verification during the current review; it is not written to browser storage or the service-worker cache. AI findings, caregiver notes, resident display name, and scene history are currently stored in unencrypted browser `localStorage`. Deleting local prototype data clears that browser state, but this prototype has no authenticated server-side record, remote revocation, managed backup deletion, or device lock policy.

Cancel stops the phone from waiting and displaying a result. If the server has already sent the request to OpenAI, the synchronous prototype server cannot cancel that provider request; it may continue until completion or its 45-second timeout.

For those reasons, this build is not a production healthcare-data system. Before real use, add authenticated caregiver/resident authorization, current consent records, encrypted transport and storage, short retention, audit logs, protected export/deletion, rate limiting, and legal/privacy/security review. Do not include sensitive details in lock-screen notifications.

AI output is limited to specific visible observations and a suggested caregiver check. It must not identify a person or pills; infer age, disability, capacity, intent, diagnosis, cognition, appetite, nutrition, adherence, neglect, or elapsed time; recommend a medication dose or schedule; or issue an automated emergency decision. Cleanliness output must describe a concrete visible access or safety concern, never score a household or treat mobility aids as clutter.

## From a scene observation to a habit anomaly

The current AI call analyzes only the submitted scene. A food or medication habit anomaly requires a separate, validated baseline built from repeated, comparable, consented visits for the same resident and area. Only human-confirmed checks should enter that baseline. Shopping days, deliveries, shared households, opaque storage, care-plan changes, moves, lighting, and capture angle can all make scenes incomparable.

Careview must therefore present AI output as a possible visible issue to verify—not as proof of a habit, medication use, food intake, or change over time.

## API shape

The browser sends only prepared frames to `POST /api/analyze`:

```json
{
  "zone": "kitchen",
  "mediaType": "video",
  "frames": [
    {
      "dataUrl": "data:image/jpeg;base64,...",
      "timestampSeconds": 6.2,
      "width": 1280,
      "height": 720
    }
  ]
}
```

The backend constrains request size and frame count, validates every data URL and timestamp, requests strict structured output, checks frame references and response lengths, and returns only normalized fields. A schema-valid result can still be factually wrong, so the caregiver must compare every observation with the visible source media.

## Test

From `C:\Work`:

```powershell
python -m unittest discover -s careview/tests -v
```

The tests do not require an API key or make a live OpenAI request. They cover the static PWA contract, image/video preparation hooks, consent, backend request validation, mocked OpenAI responses, hostile output, safe failure states, and service-worker exclusions.

Manual browser testing should also cover iPhone portrait capture, HEIC/MOV support, video seeking and sampling, consent reset, cancellation/navigation during analysis, API timeouts, inaccessible scenes, and human evidence review.

## Production checklist

- Serve the authenticated app and API over HTTPS; never expose the API key to clients.
- Enforce resident/caregiver authorization, role-based access, session expiry, consent withdrawal, and rate limits.
- Implement and verify face and identifier blocking/redaction before upload, not just a preference toggle.
- Strip metadata and audio, minimize frames, disable sensitive request logging, and delete transient media on success, failure, timeout, or cancellation.
- Keep only short-lived redacted evidence needed for human review, with explicit retention and revocation.
- Pin the model, prompt, and response-schema versions; rerun adversarial and representative-home evaluations before changes.
- Measure per-class precision/recall, serious false negatives, false alarms per home/week, unable-to-assess rate, and caregiver correction burden.
- Keep emergency contact, diagnosis, medication changes, care judgments, and external notifications outside automated model output.

## Project structure

```text
careview/
|-- server.py             # static server and protected OpenAI proxy
|-- index.html            # accessible PWA shell
|-- styles.css            # mobile and responsive presentation
|-- app.js                # capture, frame preparation, AI/demo flows, review state
|-- manifest.webmanifest  # install metadata
|-- sw.js                 # app-shell-only offline cache
|-- icon.svg              # scalable application icon
|-- icon-192.png          # install icon
|-- icon-512.png          # install and maskable icon
|-- apple-touch-icon.png  # iOS Home Screen icon
|-- scripts/
|   |-- generate-icons.ps1
|   `-- start-careview.ps1 # loads the API key from CareviewVault and starts the server
`-- tests/
    |-- test_server.py
    `-- test_static_app.py
```
