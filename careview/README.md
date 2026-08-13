# Careview AI mobile prototype

Careview is an installable, mobile-first web app for caregivers who review consented images and short videos of an older adult's kitchen, fridge/freezer, medication area, or living space. It can send carefully prepared still images to an OpenAI vision model and present objective, caregiver-reviewable observations.

Careview is not a monitoring or emergency system. It does not diagnose a condition, determine nutrition or medication adherence, judge neglect or care quality, or prove a habit from one scene. If someone may be in immediate danger, check in person and contact local emergency services.

> **Synthetic test data only.** The local prototype now includes healthcare-user
> authentication and a shared workspace patient directory, but it is not an
> electronic health record or a production healthcare system. Do not enter real
> patient information or reuse a real workplace password, especially over the
> plain-HTTP LAN mode.

## What the current build does

- Captures or selects an image or a 1-30 second video on iPhone.
- Validates media size, dimensions, duration, and browser decodability.
- Requires a fresh consent and privacy confirmation for every AI analysis.
- Converts an image to one resized JPEG before upload.
- Samples up to six timestamped JPEG frames from a video in the browser. The raw video and its audio are not uploaded.
- Calls a same-origin Python backend, which keeps the OpenAI API key off the phone.
- Uses server-side healthcare-user sessions and a shared SQLite patient directory.
- Lets workspace administrators add healthcare users; users in that workspace can search and review the same synthetic patient records.
- Stores derived AI scene results and human review notes on the server. Optional on-prem evidence retention saves only the prepared JPEG or sampled silent frames, never the original video or its audio.
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
.\careview\scripts\start-careview.ps1 -AllowUnencryptedDataTesting
```

If Windows reports that script execution is disabled, enable locally created
scripts once for your Windows account, reopen PowerShell, and retry:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

That command deliberately opts into the unencrypted repository database and is
for synthetic test records only. Use the initialized `-DataRoot` commands below
for durable on-prem storage.

The launcher retrieves the saved secret, exposes it only to the server process,
and removes it from the PowerShell process when the server stops. The vault may
prompt for its unlock password, but the OpenAI API key does not need to be
entered again. Open [http://127.0.0.1:4173](http://127.0.0.1:4173) and stop the
server with `Ctrl+C`.

At startup, the server prints a one-time initial-setup token only in its console.
Keep that token private. On the first visit through localhost or the trusted
HTTPS reverse proxy, enter that token to create the workspace administrator
account. The token expires as soon as setup succeeds or the server restarts; after
a pre-setup restart, use the new token printed by the new server process. Do not
put the token in a URL, command history, source file, or browser storage. Use a
unique password of at least 14 characters with upper- and lowercase letters, a
number, and a symbol. After setup, Careview shows the login screen on every device. The
administrator can add additional healthcare test users from the **Healthcare
staff** section on the **Care** screen. Passwords use salted scrypt hashes;
session and CSRF tokens are stored only as hashes in the local SQLite database.

Under the hood, the launcher sets `OPENAI_API_KEY` only for the process and runs
`python careview\server.py`; use the launcher so the key is never typed or stored
in the repository.

`OPENAI_MODEL` is optional; the server defaults to `gpt-5.6-terra`.

When an HTTPS reverse proxy fronts the local server, also pass
`-SecureCookie` so the browser sends session cookies only over HTTPS:

```powershell
.\careview\scripts\start-careview.ps1 `
  -DataRoot "C:\Work\careview\private-data" `
  -SecureCookie
```

Do not use `-SecureCookie` with the direct plain-HTTP LAN address; browsers will
not return that cookie over HTTP.

## Durable on-prem storage

The default `careview/data` directory remains a synthetic-development location.
On a server with only a C: drive, Careview can use the dedicated, Git-ignored
`C:\Work\careview\private-data` directory. Enable BitLocker for C: first, then
initialize the new directory once from an elevated PowerShell window:

```powershell
cd C:\Work
.\careview\scripts\initialize-careview-storage.ps1 -DataRoot "C:\Work\careview\private-data"
```

The target must be new or completely empty; the initializer will not change an
existing data tree. It replaces and verifies the root DACL so only the initializing
Windows identity, Local System, and local Administrators have inherited full
control. Startup, backup, and restore revalidate that root DACL and live BitLocker
status. The scripts reject UNC paths, OneDrive paths, links, junctions, mount
points, and other reparse points. Because this directory is inside the project
tree, deleting the project or running a Git clean command that removes ignored
files can delete the records. Keep verified backups outside the project.

To use the durable database without saving image evidence:

```powershell
.\careview\scripts\start-careview.ps1 -DataRoot "C:\Work\careview\private-data"
```

To retain evidence, put an authenticated HTTPS reverse proxy in front of
Careview's loopback address and start it with:

```powershell
.\careview\scripts\start-careview.ps1 `
  -DataRoot "C:\Work\careview\private-data" `
  -RetainEvidence `
  -SecureCookie
```

Careview intentionally refuses any durable `-DataRoot` with `-Lan`: direct LAN
mode is plain HTTP and remains synthetic-only. The reverse proxy must terminate HTTPS, forward only to
`http://127.0.0.1:4173`, preserve the `Host` header, and restrict access to the
trusted internal network or VPN. Enter the one-time setup token from a trusted
HTTPS client when creating the first administrator. Do not expose port 4173 to
the internet.

When enabled, evidence is stored under
`C:\Work\careview\private-data\media` using random opaque object keys. SQLite
stores its checksum and patient/scene/workspace
linkage, not image bytes or filesystem paths. Every media request is checked
against the signed-in user's workspace and patient record. For an image, the
retained record is the resized JPEG sent for analysis. For a video, it is up to
six sampled silent JPEG frames; the raw video and audio are never uploaded or
retained. Evidence retention is off unless `-RetainEvidence` is present.

There is currently no automatic record-expiry policy or patient deletion
workflow. Retained evidence and its backups remain until an administrator
performs an approved deletion process. Define retention, legal-hold, patient
access, correction, and deletion requirements before using this as a system of
record.

### Back up and restore

Use a separate BitLocker-protected disk or offline target for backups whenever
possible. If only C: is available, at minimum use a directory outside the app
project and copy verified backups to offline storage. Initialize it once:

```powershell
.\careview\scripts\initialize-careview-storage.ps1 `
  -DataRoot "C:\Work\CareviewBackups" `
  -Purpose Backup
```

Create a live, consistent SQLite snapshot plus only the evidence objects
referenced by that snapshot:

```powershell
.\careview\scripts\backup-careview.ps1 `
  -DataRoot "C:\Work\careview\private-data" `
  -BackupRoot "C:\Work\CareviewBackups"
```

Each timestamped backup includes a checksum manifest. The backup process runs
SQLite integrity and foreign-key checks and verifies every evidence object's
size and SHA-256 hash. A hash manifest detects corruption but is not a digital
signature; protect the backup directory itself from modification.

Verify a backup independently:

```powershell
python .\careview\scripts\backup_careview.py `
  --verify-backup "C:\Work\CareviewBackups\careview-backup-YYYYMMDDTHHMMSSZ-xxxxxx"
```

To restore, stop Careview first and run the guarded restore command. A data-root
instance lock detects a running Careview server regardless of its configured
port. The restore verifies
the backup, stages it inside the protected data root, preserves the previous
database/media in a `pre-restore-*` directory, and revokes restored sessions:

```powershell
.\careview\scripts\restore-careview.ps1 `
  -BackupDirectory "C:\Work\CareviewBackups\careview-backup-YYYYMMDDTHHMMSSZ-xxxxxx" `
  -DataRoot "C:\Work\careview\private-data"
```

Test restoration regularly. Keep multiple rotated copies, including one offline
or immutable copy, and remove `pre-restore-*` only after the restored system has
been verified and the applicable retention policy permits removal.

## Open it on an iPhone over the same Wi-Fi

For test media only, bind the server to the local network:

```powershell
cd C:\Work
.\careview\scripts\start-careview.ps1 -Lan -AllowUnencryptedDataTesting
```

Find the computer's Wi-Fi IPv4 address with `ipconfig`. Connect both devices to the same trusted, non-guest Wi-Fi and open this form of address in iPhone Safari:

```text
http://YOUR-WINDOWS-IP:4173/
```

For the current computer that was `http://192.168.2.221:4173/`; it can change after reconnecting. Do not use the public IP address. If the page times out, set the trusted home Wi-Fi profile to Private and allow Python through Windows Defender Firewall on Private networks only. Keep the server window open and the computer awake.

This LAN setup uses plain HTTP. Login credentials, session cookies, patient
records, and uploaded frames are not encrypted in transit, and iPhone
service-worker/install behavior requires a secure context. Use only synthetic
users, patients, and non-sensitive media. Do not use real resident imagery,
medication information, personal data, or a reused password.

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

The selected source file remains in browser memory for preview and is not
written to browser storage, SQLite, or the service-worker cache. Derived AI
findings, healthcare-user review notes, patient display names, and scene history
are stored in SQLite. When on-prem evidence retention is enabled, only the
prepared JPEG evidence is written to the configured private media directory;
the original video and audio are never retained. Browser `localStorage` contains
only non-sensitive UI preferences. SQLite and evidence files are not encrypted
by the application itself, so the configured Windows volume and every backup
must be encrypted. The prototype still lacks patient-specific assignments,
verified consent records, and complete retention/deletion controls.

Cancel stops the phone from waiting and displaying a result. If the server has already sent the request to OpenAI, the synchronous prototype server cannot cancel that provider request; it may continue until completion or its 45-second timeout.

For those reasons, this build is not a production healthcare-data system. Before real use, add authenticated caregiver/resident authorization, current consent records, encrypted transport and storage, short retention, audit logs, protected export/deletion, rate limiting, and legal/privacy/security review. Do not include sensitive details in lock-screen notifications.

AI output is limited to specific visible observations and a suggested caregiver check. It must not identify a person or pills; infer age, disability, capacity, intent, diagnosis, cognition, appetite, nutrition, adherence, neglect, or elapsed time; recommend a medication dose or schedule; or issue an automated emergency decision. Cleanliness output must describe a concrete visible access or safety concern, never score a household or treat mobility aids as clutter.

## From a scene observation to a habit anomaly

The current AI call analyzes only the submitted scene. A food or medication habit anomaly requires a separate, validated baseline built from repeated, comparable, consented visits for the same resident and area. Only human-confirmed checks should enter that baseline. Shopping days, deliveries, shared households, opaque storage, care-plan changes, moves, lighting, and capture angle can all make scenes incomparable.

Careview must therefore present AI output as a possible visible issue to verify—not as proof of a habit, medication use, food intake, or change over time.

## API shape

After authenticating and selecting an authorized patient, the browser sends only
prepared frames to `POST /api/patients/{patientId}/analyze`:

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

The backend verifies the session, workspace and CSRF token, constrains request
size and frame count, validates every data URL and timestamp, requests strict
structured output, and checks frame references and response lengths. It always
persists normalized derived fields. When explicitly enabled, it also persists
the validated prepared evidence bytes after a successful saved analysis. A
schema-valid result can still be factually wrong, so the caregiver must compare
every observation with the visible source media.

Authentication and shared-record endpoints include:
`GET /api/session`, `POST /api/login`, `POST /api/logout`,
`GET /api/patients`, `POST /api/patients`,
`GET /api/patients/{patientId}/scenes`, protected scene-media reads, and
optimistic `PATCH` updates for findings. Only administrators can list or add
workspace healthcare users.

## Test

From `C:\Work`:

```powershell
python -m unittest discover -s careview/tests -v
```

The tests do not require an API key or make a live OpenAI request. They cover the static PWA contract, image/video preparation hooks, consent, backend request validation, mocked OpenAI responses, hostile output, safe failure states, and service-worker exclusions.

Manual browser testing should also cover iPhone portrait capture, HEIC/MOV support, video seeking and sampling, consent reset, cancellation/navigation during analysis, API timeouts, inaccessible scenes, and human evidence review.

## Production checklist

- Serve the authenticated app and API over HTTPS; never expose the API key to clients.
- Replace workspace-wide visibility with patient-specific assignments and minimum-necessary role permissions.
- Add MFA or passkeys, workforce lifecycle controls, secure account recovery, consent withdrawal, and broader rate limits.
- Encrypt the database, backups, and managed keys; test restoration, retention, deletion, and revocation.
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
|-- careview_store.py     # authenticated SQLite records and evidence metadata
|-- index.html            # accessible PWA shell
|-- styles.css            # mobile and responsive presentation
|-- app.js                # capture, frame preparation, AI/demo flows, review state
|-- manifest.webmanifest  # install metadata
|-- sw.js                 # app-shell-only offline cache
|-- icon.svg              # scalable application icon
|-- icon-192.png          # install icon
|-- icon-512.png          # install and maskable icon
|-- apple-touch-icon.png  # iOS Home Screen icon
|-- data/                 # ignored synthetic-development database/media location
|-- scripts/
|   |-- backup-careview.ps1
|   |-- backup_careview.py
|   |-- generate-icons.ps1
|   |-- initialize-careview-storage.ps1
|   |-- restore-careview.ps1
|   `-- start-careview.ps1
`-- tests/
    |-- test_backup.py
    |-- test_server.py
    `-- test_static_app.py
```
