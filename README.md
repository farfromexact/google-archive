# Google Drive archive sync

This repository is the GitHub archive target for the `Global-Cross-Asset-Radar`
Gemini output folder.

The synchronizer is a standalone Google Apps Script in
[`apps-script/Code.gs`](apps-script/Code.gs). It:

- reads `.json` and `.md` files in the configured Drive folder and its managed
  `reports/`, `latest/`, `status/`, and `manifests/` subfolders;
- ignores `archive/duplicates/` so preserved historical duplicates are not
  uploaded over canonical files;
- selects the most recently updated file when Drive temporarily contains
  duplicate names during an automation transition;
- routes files using the paths declared by `reports.json`;
- updates an existing GitHub file only when its content changed;
- keeps old GitHub files when they disappear from Drive, because this is an
  archive rather than a mirror;
- uses a script lock so overlapping timer runs do not create conflicting writes.

## One-time setup

1. Create a fine-grained GitHub token scoped only to
   `farfromexact/google-archive` with repository `Contents: Read and write`
   permission. Do not commit or paste the token into `Code.gs`.
2. Open [Google Apps Script](https://script.google.com/) and create a standalone
   project.
3. Add the two files from `apps-script/`: `Code.gs` and `appsscript.json`.
4. In **Project Settings -> Script properties**, add:

   | Property | Value |
   | --- | --- |
   | `DRIVE_FOLDER_ID` | the ID from your Drive folder URL |
   | `GITHUB_OWNER` | `farfromexact` |
   | `GITHUB_REPO` | `google-archive` |
   | `GITHUB_BRANCH` | `main` |
   | `GITHUB_BASE_PATH` | `global-cross-asset-radar` |
   | `GITHUB_TOKEN` | your token, stored only as a Script property |

   The GitHub values are also safe defaults in the script; the Drive folder ID
   is intentionally required as a private Script property and is not stored in
   this public repository.

5. Run `validateConfiguration` once and approve the Google permissions. This
   checks both the Drive folder and the GitHub repository.
6. Run `syncDriveToGitHub` once. This should create/update the `.json` and
   `.md` files in GitHub.
7. Run `installTrigger` once. It creates a 15-minute trigger. Apps Script will
   email the script owner if a scheduled execution fails.

The target paths will look like:

```text
global-cross-asset-radar/reports/2026/10/2026-10-16_morning.json
global-cross-asset-radar/reports/2026/10/2026-10-16_morning.md
global-cross-asset-radar/latest/morning.json
global-cross-asset-radar/latest/morning.md
global-cross-asset-radar/status/morning_latest.json
global-cross-asset-radar/manifests/reports.json
```

The date snapshots remain in `reports/YYYY/MM/`, while the stable files in
`latest/`, `status/`, and `manifests/` are updated in place each day. If a
future `reports.json` declares new editions or paths, the synchronizer uses
those declarations automatically.

## Operational notes

- Drive is the source of truth; this is intentionally one-way.
- The root folder and the four managed subfolder trees are processed. Other
  unrelated Drive subfolders and `archive/duplicates/` are ignored.
- Drive files are never deleted or moved by the synchronizer. Duplicate names
  are handled by selecting the most recently updated copy for synchronization.
- Files with other extensions are ignored.
- Existing GitHub content is never deleted automatically by the timer. The
  initial flat-layout files should be moved once when adopting the organized
  layout.
- A separate GitHub commit is created for each changed file. This keeps the
  implementation simple and makes each source-file update independently
  traceable.
- The GitHub token is never written to logs by the script.

## Empty repository bootstrap

If the first `syncDriveToGitHub` run reports that GitHub cannot write to an
empty repository, create a one-line `README.md` in the repository through the
GitHub web UI, then run the synchronizer again. Later runs use the normal
create/update API path.
