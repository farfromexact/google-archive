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
 * Synchronizes all .json and .md files directly inside the Drive folder.
 * Existing GitHub files are updated; files removed from Drive are intentionally
 * not deleted from GitHub because this repository is an archive.
 */
function syncDriveToGitHub() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Another synchronization is already running.');
  }

  try {
    var config = getConfig_();
    var folder = DriveApp.getFolderById(config.driveFolderId);
    var files = [];
    var iterator = folder.getFiles();

    while (iterator.hasNext()) {
      var file = iterator.next();
      if (/\.(json|md)$/i.test(file.getName())) {
        files.push(file);
      }
    }

    files.sort(function(left, right) {
      return left.getName().localeCompare(right.getName());
    });

    var summary = {
      folder: folder.getName(),
      discovered: files.length,
      synced: 0,
      unchanged: 0,
      failed: []
    };

    files.forEach(function(file) {
      try {
        var content = readTextFile_(file);
        var repoPath = buildRepositoryPath_(config, file.getName());
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

  return [config.githubBasePath, safeName]
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
