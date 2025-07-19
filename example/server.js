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

let metadataOpts;
if (process.platform === 'darwin') {
  metadataOpts = {
    httpOptions: { connectTimeout: 5, timeout: 5 },
    maxRetries: 0,
  };
}

const opts = {
  secret: config.SECRET || 'secure',
  port: 80,
  region: config.AWS_REGION,
  asgName: config.ASG_NAME,
  remoteRepoPrefix: config.S3_REPO_PREFIX,
  metadataOpts,
  repoDir: config.TEST_REPO_DIR,
};
const sc_router = express.Router();
serverControl.init(sc_router, opts);
app.use(sc_router);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
