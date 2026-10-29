# Google Drive archive sync — **PAUSED**

> **Status (2026-10-29 Asia/Shanghai): temporarily disabled.**  
> Cong has stopped the Gemini → Drive automation for「全球跨资产机会雷达」and the Apps Script sync into this repo. Historical files under `global-cross-asset-radar/` remain as an archive; **do not treat this repo as the live writing target.**

## Current radar pipeline

| Role | Target |
| --- | --- |
| Live morning / evening radar (Grok Bot) | [`farfromexact/Global-Cross-Asset-Radar-Grok`](https://github.com/farfromexact/Global-Cross-Asset-Radar-Grok) |
| This repo (`google-archive`) | **Paused** — historical Drive→GitHub sync only |
| Gemini chatbox Drive-save / second-opinion automations | **Paused** (region / ops switch) |

To resume later: re-enable the Apps Script time trigger (`installTrigger`), restore Drive Gemini output, and clear this pause banner.

To fully shut down Apps Script now (recommended while paused): open the standalone Apps Script project → **Triggers** → delete the 15-minute `syncDriveToGitHub` trigger (or run any uninstall helper if you added one). Leaving the token in Script properties is fine; just stop the timer so it does not keep writing.

---

## What this repo used to do (reference)

This repository was the GitHub archive target for the `Global-Cross-Asset-Radar` Gemini output folder on Google Drive.

The synchronizer is a standalone Google Apps Script in [`apps-script/Code.gs`](apps-script/Code.gs). It:

- reads `.json` and `.md` files in the configured Drive folder and its managed `reports/`, `latest/`, `status/`, and `manifests/` subfolders;
- ignores `archive/duplicates/` so preserved historical duplicates are not uploaded over canonical files;
- selects the most recently updated file when Drive temporarily contains duplicate names during an automation transition;
- routes files using the paths declared by `reports.json`;
- updates an existing GitHub file only when its content changed;
- keeps old GitHub files when they disappear from Drive, because this is an archive rather than a mirror;
- uses a script lock so overlapping timer runs do not create conflicting writes.

### One-time setup (historical)

1. Create a fine-grained GitHub token scoped only to `farfromexact/google-archive` with repository `Contents: Read and write` permission. Do not commit or paste the token into `Code.gs`.
2. Open [Google Apps Script](https://script.google.com/) and create a standalone project.
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

5. Run `validateConfiguration` once and approve the Google permissions.
6. Run `syncDriveToGitHub` once.
7. Run `installTrigger` once (15-minute trigger). **While paused, leave this uninstalled / deleted.**

Target paths looked like:

```text
global-cross-asset-radar/reports/2026/10/2026-10-16_morning.json
global-cross-asset-radar/latest/morning.md
global-cross-asset-radar/status/morning_latest.json
global-cross-asset-radar/manifests/reports.json
```

### Operational notes (historical)

- Drive was the source of truth; sync was intentionally one-way.
- Existing GitHub content was never deleted automatically by the timer.
- A separate GitHub commit was created for each changed file.
- The GitHub token is never written to logs by the script.
