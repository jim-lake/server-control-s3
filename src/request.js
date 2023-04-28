const AWS = require('aws-sdk');
const request = require('request');

exports.webRequest = webRequest;
exports.fetchFileContents = fetchFileContents;

function webRequest(opts, done) {
  request(opts, (err, response, body) => {
    const statusCode = response && response.statusCode;
    if (!err && (statusCode < 200 || statusCode > 299)) {
      err = statusCode;
    }
    done(err, body);
  });
}
function fetchFileContents(url, done) {
  if (url.indexOf('http') === 0) {
    webRequest({ url }, done);
  } else {
    const parts = url.match(/s3:\/\/([^/]*)\/(.*)/);
    const Bucket = parts && parts[1];
    const Key = parts && parts[2];
    const s3 = new AWS.S3();
    s3.getObject({ Bucket, Key }, (err, data) => {
      done(err, data && data.Body && data.Body.toString('utf8'));
    });
  }
}
