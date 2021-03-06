import request from 'superagent';
import cookies from 'cookies-js';

import config from '../config';
import * as Defaults from './DefaultsUtil';

const GITHUB_AUTH_URL = `https://github.com/login/oauth/authorize?client_id=${
  config.GITHUB_CLIENT_ID
}&scope=gist`;
const GITHUB_GISTS_API = 'https://api.github.com/gists';
const COOKIE_TTL = 60 * 60 * 24 * 30 * 6; // 6 months

const authState = {
  tries: 0,
  successFn: () => {},
  errorFn: () => {}
};

// message with github oauth code comes from ./public/login.html
window.addEventListener('message', onLoginHTMLMessage, false);

function onLoginHTMLMessage(e) {
  if (e.origin !== window.location.origin) {
    return;
  }

  const { githubAuthCode } = e.data;

  if (githubAuthCode) {
    getAccessToken(githubAuthCode)
      .then(() => authState.successFn())
      .catch(err => authState.errorFn(err));
  }
}

function authorize() {
  return new Promise((resolve, reject) => {
    authState.tries++;

    if (authState.tries >= 3) {
      return reject(new Error(`Too many tries to open ${GITHUB_AUTH_URL}`));
    }

    authState.successFn = resolve;
    authState.errorFn = reject;

    window.open(GITHUB_AUTH_URL);
  });
}

function getAccessToken(code) {
  return new Promise((resolve, reject) => {
    if (!code) {
      return reject(
        new Error('Impossible to get access token, code is not present')
      );
    }

    request
      .get(config.GATEKEEPER)
      .query({ code })
      .end((err, res) => {
        if (err) {
          return reject(err);
        }

        const token = res.body.token;

        cookies.set('oauth_token', token, { expires: COOKIE_TTL });
        resolve(token);
      });
  });
}

function requestGistApi(method = 'GET', data = {}) {
  let url = GITHUB_GISTS_API;

  if (data.id) {
    url += `/${data.id}`;
  }

  if (data.sha) {
    url += `/${data.sha}`;
  }

  const makeRequest = () => {
    return new Promise((resolve, reject) => {
      const access_token = cookies.get('oauth_token');
      const loginAndRetry = () => {
        authorize()
          .then(() =>
            makeRequest()
              .then(resolve)
              .catch(reject)
          )
          .catch(reject);
      };

      if (!access_token) {
        return loginAndRetry();
      }

      return request(method, url)
        .query({ access_token })
        .send(data.body)
        .then(res => {
          return resolve(res.body || {});
        })
        .catch(err => {
          if (err.status === 401) {
            return loginAndRetry();
          }

          return reject(err);
        });
    });
  };

  return makeRequest();
}

function getGistDataFormat(data = {}, status = 'public', gistId) {
  const markdownLink = gistId
    ? `http://esnextb.in/?gist=${gistId}`
    : 'http://esnextb.in';
  const gistMeta = {
    description: 'esnextbin sketch',
    markdown: `made with [esnextbin](${markdownLink})`
  };

  try {
    const jsonData = JSON.parse(data.json);

    if (jsonData.description) {
      gistMeta.description = jsonData.description;
    }
  } catch (err) {
    // fail silently
  }

  return {
    description: gistMeta.description,
    public: status === 'public',
    files: {
      'index.js': {
        content: data.code.trim() || Defaults.CODE
      },
      'transpiled.js': {
        content: data.transpiledCode.trim() || Defaults.CODE
      },
      'index.html': {
        content: data.html.trim() || Defaults.HTML
      },
      'package.json': {
        content: data.json.trim() || Defaults.PACKAGE_JSON
      },
      'esnextbin.md': {
        content: gistMeta.markdown
      }
    }
  };
}

function transformGistData(files) {
  if (!files || !files['index.js']) {
    return;
  }

  return {
    code: files['index.js'].content,
    html: (files['index.html'] && files['index.html'].content) || Defaults.HTML,
    json:
      (files['package.json'] && files['package.json'].content) ||
      Defaults.PACKAGE_JSON
  };
}

export function getGist(opts = {}) {
  return new Promise((resolve, reject) => {
    const sendData = {
      id: opts.id,
      sha: opts.sha
    };

    requestGistApi('GET', sendData)
      .then(data => {
        const gistData = transformGistData(data.files);

        if (!gistData) {
          return reject(new Error('No index.js in the gist'));
        }

        resolve(gistData);
      })
      .catch(reject);
  });
}

export function createGist(opts = {}) {
  return new Promise((resolve, reject) => {
    const sendData = {
      body: getGistDataFormat(opts.data, opts.status)
    };

    requestGistApi('POST', sendData)
      .then(data => {
        if (opts.isFork) {
          data.isFork = true;
        }

        resolve(data);
      })
      .catch(reject);
  });
}

export function updateGist(opts = {}) {
  return new Promise((resolve, reject) => {
    const sendData = {
      id: opts.id,
      body: getGistDataFormat(opts.data, opts.status, opts.id)
    };

    requestGistApi('PATCH', sendData)
      .then(resolve)
      .catch(err => {
        if (err.status === 404) {
          opts.isFork = true;

          return createGist(opts)
            .then(resolve)
            .catch(reject);
        }

        reject(err);
      });
  });
}

export function unauthorize() {
  cookies.expire('oauth_token');
}
