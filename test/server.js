const express = require('express');
const serverControl = require('../src/index.js');

const port = 3000;
const app = express();

app.get('/', (req, res) => {
  res.send('Hello World!');
});

let metadata_opts;
if (process.platform === 'darwin') {
  metadata_opts = {
    httpOptions: { connectTimeout: 5, timeout: 5 },
    maxRetries: 0,
  };
}

const opts = {
  secret: process.env.SECRET || 'secure',
  port: 80,
  region: process.env.AWS_REGION,
  asg_name: process.env.ASG_NAME,
  remote_repo_prefix: process.env.S3_REPO_PREFIX,
  metadata_opts,
};
serverControl.init(app, opts);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
