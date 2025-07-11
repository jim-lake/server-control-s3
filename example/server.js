const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const serverControl = require('../dist/server_control.js');

const config = require('./config.json');

const port = 3000;
const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser());

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.get('/dump', (req, res) => {
  res.send({ header: req.headers, query: req.query, body: req.body });
});

let metadata_opts;
if (process.platform === 'darwin') {
  metadata_opts = {
    httpOptions: { connectTimeout: 5, timeout: 5 },
    maxRetries: 0,
  };
}

const opts = {
  secret: config.SECRET || 'secure',
  port: 80,
  region: config.AWS_REGION,
  asg_name: config.ASG_NAME,
  remote_repo_prefix: config.S3_REPO_PREFIX,
  metadata_opts,
  repo_dir: config.TEST_REPO_DIR,
};
serverControl.init(app, opts);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
