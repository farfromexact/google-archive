/**
 * Google Drive -> GitHub archive synchronizer.
 *
 * Run this as a standalone Google Apps Script project. Configuration is read
 * from Apps Script Project Settings -> Script properties. The GitHub token is
 * deliberately not stored in this source file.
 */

var DEFAULTS = {
  driveFolderId: '',
  githubOwner: 'farfromexact',
  githubRepo: 'google-archive',
  githubBranch: 'main',
  githubBasePath: 'global-cross-asset-radar',
  triggerMinutes: 15
};

var GITHUB_API = 'https://api.github.com';
var GITHUB_API_VERSION = '2022-11-28';
var SYNC_SUBFOLDERS = ['reports', 'latest', 'status', 'manifests'];

/** Checks Drive access, GitHub access, and the configured target repository. */
function validateConfiguration() {
  var config = getConfig_();
  var folder = DriveApp.getFolderById(config.driveFolderId);
  var repository = githubRequest_(config, 'get', '/repos/' +
    encodeURIComponent(config.githubOwner) + '/' +
    encodeURIComponent(config.githubRepo));

  if (repository.code !== 200) {
    throw new Error('GitHub repository check failed: ' + githubMessage_(repository));
  }

  Logger.log(JSON.stringify({
    driveFolder: folder.getName(),
    githubRepository: repository.body.full_name,
    branch: config.githubBranch,
    basePath: config.githubBasePath
  }));
}

/** Installs one 15-minute trigger without creating duplicates. */
function installTrigger() {
  getConfig_();
  var alreadyInstalled = ScriptApp.getProjectTriggers().some(function(trigger) {
    return trigger.getHandlerFunction() === 'syncDriveToGitHub';
  });

  if (!alreadyInstalled) {
    ScriptApp.newTrigger('syncDriveToGitHub')
      .timeBased()
      .everyMinutes(DEFAULTS.triggerMinutes)
      .create();
    Logger.log('Installed a ' + DEFAULTS.triggerMinutes + '-minute sync trigger.');
  } else {
    Logger.log('A sync trigger is already installed.');
  }
}

/**
 * Synchronizes .json and .md files in the Drive folder and its managed
 * subfolders. The archive/duplicates tree is intentionally excluded.
 * The reports.json manifest declares the archive paths. Existing GitHub files
 * are updated; files removed from Drive are intentionally not deleted from
 * GitHub because this repository is an archive.
 */
function syncDriveToGitHub() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Another synchronization is already running.');
  }

  try {
    var config = getConfig_();
    var folder = DriveApp.getFolderById(config.driveFolderId);
    var discoveredFiles = collectSyncFiles_(folder);
    var selection = selectLatestDriveFiles_(discoveredFiles);
    var files = selection.files;

    files.sort(function(left, right) {
      return left.getName().localeCompare(right.getName());
    });

    var repositoryPaths = buildRepositoryPathMap_(config, files);

    var summary = {
      folder: folder.getName(),
      discovered: discoveredFiles.length,
      selected: files.length,
      duplicatesIgnored: selection.duplicatesIgnored,
      synced: 0,
      unchanged: 0,
      failed: []
    };

    files.forEach(function(file) {
      try {
        var content = readTextFile_(file);
        var repoPath = repositoryPaths[file.getName()] ||
          buildRepositoryPath_(config, file.getName());
        var remote = getRemoteFile_(config, repoPath);

        if (remote && remote.content) {
          var remoteContent = decodeGitHubContent_(remote.content);
          if (sha256_(content) === sha256_(remoteContent)) {
            summary.unchanged += 1;
            return;
          }
        }

        var result = putGitHubFile_(config, repoPath, content, remote && remote.sha,
          'sync: ' + file.getName());
        summary.synced += 1;
        Logger.log(JSON.stringify({
          file: file.getName(),
          path: repoPath,
          commit: result && result.commit ? result.commit.html_url : null
        }));
      } catch (error) {
        summary.failed.push({
          file: file.getName(),
          error: String(error && error.message ? error.message : error)
        });
      }
    });

    Logger.log(JSON.stringify(summary));
    if (summary.failed.length) {
      throw new Error('Synchronization completed with failures: ' +
        JSON.stringify(summary.failed));
    }
    return summary;
  } finally {
    lock.releaseLock();
  }
}

/** Collects root files and files below the four managed archive directories. */
function collectSyncFiles_(rootFolder) {
  var candidates = [];
  collectSyncFilesInFolder_(rootFolder, '', candidates);
  return candidates;
}

function collectSyncFilesInFolder_(folder, relativeDirectory, candidates) {
  var fileIterator = folder.getFiles();
  while (fileIterator.hasNext()) {
    var file = fileIterator.next();
    if (/\.(json|md)$/i.test(file.getName())) {
      candidates.push({
        file: file,
        relativePath: relativeDirectory + file.getName()
      });
    }
  }

  var folderIterator = folder.getFolders();
  while (folderIterator.hasNext()) {
    var child = folderIterator.next();
    var childDirectory = relativeDirectory + child.getName() + '/';
    if (isManagedSyncDirectory_(childDirectory)) {
      collectSyncFilesInFolder_(child, childDirectory, candidates);
    }
  }
}

function isManagedSyncDirectory_(relativeDirectory) {
  var parts = relativeDirectory.split('/').filter(function(part) {
    return part !== '';
  });
  if (!parts.length) {
    return false;
  }

  for (var index = 0; index < parts.length; index += 1) {
    var part = parts[index].toLowerCase();
    if (part === 'archive' || part === 'duplicates') {
      return false;
    }
  }

  return SYNC_SUBFOLDERS.indexOf(parts[0].toLowerCase()) !== -1;
}

/**
 * Drive permits duplicate names. During the transition from a flat folder,
 * choose the newest file for each name so an old root copy cannot overwrite
 * a newer organized copy. No Drive files are deleted or moved here.
 */
function selectLatestDriveFiles_(candidates) {
  var selectedByName = {};
  var duplicatesIgnored = 0;

  candidates.forEach(function(candidate) {
    var key = candidate.file.getName().toLowerCase();
    var current = selectedByName[key];
    if (!current) {
      selectedByName[key] = candidate;
      return;
    }

    duplicatesIgnored += 1;
    var candidateTime = candidate.file.getLastUpdated().getTime();
    var currentTime = current.file.getLastUpdated().getTime();
    if (candidateTime > currentTime ||
        (candidateTime === currentTime &&
         candidate.relativePath.localeCompare(current.relativePath) > 0)) {
      selectedByName[key] = candidate;
    }
  });

  return {
    files: Object.keys(selectedByName).map(function(key) {
      return selectedByName[key].file;
    }),
    duplicatesIgnored: duplicatesIgnored
  };
}

function getConfig_() {
  var properties = PropertiesService.getScriptProperties().getProperties();
  var config = {
    driveFolderId: properties.DRIVE_FOLDER_ID || DEFAULTS.driveFolderId,
    githubOwner: properties.GITHUB_OWNER || DEFAULTS.githubOwner,
    githubRepo: properties.GITHUB_REPO || DEFAULTS.githubRepo,
    githubBranch: properties.GITHUB_BRANCH || DEFAULTS.githubBranch,
    githubBasePath: properties.GITHUB_BASE_PATH === undefined ?
      DEFAULTS.githubBasePath : properties.GITHUB_BASE_PATH,
    githubToken: properties.GITHUB_TOKEN || ''
  };

  if (!config.githubToken) {
    throw new Error(
      'Missing Script property GITHUB_TOKEN. Do not put the token in Code.gs.'
    );
  }
  if (!config.driveFolderId) {
    throw new Error('Missing Script property DRIVE_FOLDER_ID.');
  }
  return config;
}

function readTextFile_(file) {
  var name = file.getName();
  var extension = name.toLowerCase().slice(name.lastIndexOf('.'));

  // Native Google Docs files need to be exported before reading their text.
  if (file.getMimeType() === 'application/vnd.google-apps.document') {
    return exportDriveFile_(file.getId(), extension === '.md' ?
      'text/markdown' : 'text/plain');
  }

  return file.getBlob().getDataAsString('UTF-8');
}

function exportDriveFile_(fileId, exportMimeType) {
  var url = 'https://www.googleapis.com/drive/v3/files/' +
    encodeURIComponent(fileId) + '/export?mimeType=' +
    encodeURIComponent(exportMimeType);
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Drive export failed (' + response.getResponseCode() + '): ' +
      response.getContentText());
  }
  return response.getContentText('UTF-8');
}

function buildRepositoryPath_(config, fileName) {
  var safeName = String(fileName)
    .replace(/[\\/]/g, '_')
    .replace(/^\.+/, '_');

  if (!/\.(json|md)$/i.test(safeName)) {
    throw new Error('Unsupported file extension: ' + fileName);
  }

  var datedFile = safeName.match(/^(\d{4})-(\d{2})-(\d{2})_.+\.(json|md)$/i);
  if (datedFile) {
    return joinRepositoryPath_(config,
      'reports/' + datedFile[1] + '/' + datedFile[2] + '/' + safeName);
  }

  if (safeName.toLowerCase() === 'reports.json') {
    return joinRepositoryPath_(config, 'manifests/reports.json');
  }

  if (/_latest\.json$/i.test(safeName)) {
    return joinRepositoryPath_(config, 'status/' + safeName);
  }

  return joinRepositoryPath_(config, 'latest/' + safeName);
}

/**
 * Uses the report manifest when available so new editions can declare their
 * own archive, latest, and status paths without another code change.
 */
function buildRepositoryPathMap_(config, files) {
  var pathMap = {};
  files.forEach(function(file) {
    pathMap[file.getName()] = buildRepositoryPath_(config, file.getName());
  });

  var manifestFile = files.find(function(file) {
    return file.getName().toLowerCase() === 'reports.json';
  });
  if (!manifestFile) {
    return pathMap;
  }

  try {
    var manifest = JSON.parse(readTextFile_(manifestFile));
    if (manifest && Array.isArray(manifest.reports)) {
      manifest.reports.forEach(function(report) {
        addManifestPath_(config, pathMap, report.md_path);
        addManifestPath_(config, pathMap, report.json_path);
        addManifestPath_(config, pathMap, report.latest_md_path);
        addManifestPath_(config, pathMap, report.latest_json_path);
        addManifestPath_(config, pathMap, report.status_path);
      });
    }
    pathMap[manifestFile.getName()] = joinRepositoryPath_(config,
      'manifests/reports.json');
  } catch (error) {
    Logger.log('Manifest path mapping unavailable; using filename rules: ' +
      String(error && error.message ? error.message : error));
  }

  return pathMap;
}

function addManifestPath_(config, pathMap, relativePath) {
  if (!relativePath) {
    return;
  }
  var normalized = String(relativePath).replace(/\\/g, '/').replace(/^\/+/, '');
  var fileName = normalized.split('/').pop();
  if (fileName) {
    pathMap[fileName] = joinRepositoryPath_(config, normalized);
  }
}

function joinRepositoryPath_(config, relativePath) {
  return [config.githubBasePath, String(relativePath).replace(/^\/+/, '')]
    .filter(function(part) { return part !== ''; })
    .join('/');
}

function getRemoteFile_(config, repoPath) {
  var endpoint = '/repos/' + encodeURIComponent(config.githubOwner) + '/' +
    encodeURIComponent(config.githubRepo) + '/contents/' + encodePath_(repoPath) +
    '?ref=' + encodeURIComponent(config.githubBranch);
  var response = githubRequest_(config, 'get', endpoint);

  if (response.code === 404) {
    return null;
  }
  if (response.code !== 200 || !response.body || Array.isArray(response.body)) {
    throw new Error('Cannot read GitHub path ' + repoPath + ': ' +
      githubMessage_(response));
  }

  return {
    sha: response.body.sha,
    content: response.body.content || ''
  };
}

function putGitHubFile_(config, repoPath, content, sha, message) {
  var endpoint = '/repos/' + encodeURIComponent(config.githubOwner) + '/' +
    encodeURIComponent(config.githubRepo) + '/contents/' + encodePath_(repoPath);
  var bytes = Utilities.newBlob(content, 'text/plain').getBytes();
  var payload = {
    message: message,
    content: Utilities.base64Encode(bytes),
    branch: config.githubBranch
  };

  if (sha) {
    payload.sha = sha;
  }

  var response = githubRequest_(config, 'put', endpoint, payload);
  if (response.code !== 200 && response.code !== 201) {
    throw new Error('Cannot write GitHub path ' + repoPath + ': ' +
      githubMessage_(response));
  }
  return response.body;
}

function githubRequest_(config, method, endpoint, payload) {
  var options = {
    method: method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + config.githubToken,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'google-drive-archive-sync'
    },
    muteHttpExceptions: true
  };

  if (payload !== undefined) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  var response = UrlFetchApp.fetch(GITHUB_API + endpoint, options);
  var raw = response.getContentText();
  var body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch (ignored) {
    body = { message: raw };
  }

  return {
    code: response.getResponseCode(),
    body: body
  };
}

function githubMessage_(response) {
  return response && response.body && response.body.message ?
    response.body.message : 'HTTP ' + (response ? response.code : 'unknown');
}

function encodePath_(path) {
  return path.split('/').map(function(segment) {
    return encodeURIComponent(segment);
  }).join('/');
}

function decodeGitHubContent_(content) {
  var bytes = Utilities.base64Decode(String(content).replace(/\s/g, ''));
  return Utilities.newBlob(bytes).getDataAsString('UTF-8');
}

function sha256_(text) {
  var bytes = Utilities.newBlob(text, 'text/plain').getBytes();
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  return digest.map(function(value) {
    var unsigned = value < 0 ? value + 256 : value;
    return (unsigned < 16 ? '0' : '') + unsigned.toString(16);
  }).join('');
}
