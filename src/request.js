const {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const http = require('http');
const https = require('https');
const url_lib = require('url');

const TIMEOUT = 15 * 1000;

exports.webRequest = webRequest;
exports.headUrl = headUrl;
exports.fetchFileContents = fetchFileContents;

function webRequest(opts, done) {
  if (!opts.timeout) {
    opts.timeout = TIMEOUT;
  }

  const url = new url_lib.URL(opts.url);
  const transport = url.protocol === 'https:' ? https : http;

  const request_options = {
    method: opts.method || 'GET',
    timeout: opts.timeout,
    headers: opts.headers || {},
  };

  let request_body;
  if (opts.json) {
    if (request_options.method === 'GET') {
      Object.keys(opts.json).forEach((key) => {
        url.searchParams.append(key, opts.json[key]);
      });
    } else {
      request_body = JSON.stringify(opts.json);
      request_options.headers['Content-Type'] = 'application/json';
      request_options.headers['Content-Length'] =
        Buffer.byteLength(request_body);
    }
  }

  const client_req = transport.request(url, request_options, (incoming_res) => {
    let response_body = '';
    incoming_res.on('data', (chunk) => {
      response_body += chunk;
    });

    incoming_res.on('end', () => {
      const status_code = incoming_res.statusCode;
      let err = null;
      if (status_code < 200 || status_code > 299) {
        err = status_code;
      }

      const content_type = incoming_res.headers['content-type'] || '';
      if (content_type.includes('application/json')) {
        try {
          response_body = JSON.parse(response_body);
        } catch (e) {
          // ignore
        }
      }

      done(err, response_body);
    });
  });

  client_req.on('error', (err) => {
    done(err);
  });

  client_req.on('timeout', () => {
    client_req.destroy();
    const err = new Error('Request timed out');
    err.code = 'ETIMEDOUT';
    done(err);
  });

  if (request_body) {
    client_req.write(request_body);
  }

  client_req.end();
}

function headUrl(url, opts, done) {
  if (typeof opts === 'function') {
    done = opts;
    opts = {};
  }
  if (url.indexOf('http') === 0) {
    webRequest({ url, method: 'HEAD' }, done);
  } else {
    const parts = url.match(/s3:\/\/([^/]*)\/(.*)/);
    const Bucket = parts && parts[1];
    const Key = parts && parts[2];
    const s3 = new S3Client({ region: opts.region });
    const command = new HeadObjectCommand({ Bucket, Key });
    s3.send(command).then(
      (data) => done(null, data),
      (err) => done(err)
    );
  }
}
function fetchFileContents(url, opts, done) {
  if (typeof opts === 'function') {
    done = opts;
    opts = {};
  }
  if (url.indexOf('http') === 0) {
    webRequest({ url }, done);
  } else {
    const parts = url.match(/s3:\/\/([^/]*)\/(.*)/);
    const Bucket = parts && parts[1];
    const Key = parts && parts[2];
    const s3 = new S3Client({ region: opts.region });
    const command = new GetObjectCommand({ Bucket, Key });
    s3.send(command).then(
      (data) => {
        const stream = data.Body;
        let body = '';
        stream.on('data', (chunk) => {
          body += chunk.toString();
        });
        stream.on('end', () => {
          done(null, body);
        });
        stream.on('error', (err) => {
          done(err);
        });
      },
      (err) => done(err)
    );
  }
}
