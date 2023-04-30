const async = require('async');
require('aws-sdk/lib/maintenance_mode_message').suppress = true;
const AWS = require('aws-sdk');
const body_parser = require('body-parser');
const child_process = require('child_process');
const cookie_parser = require('cookie-parser');
const fs = require('fs');
const { join: pathJoin } = require('path');
const { webRequest, headUrl, fetchFileContents } = require('./request');

exports.init = init;
exports.getGitCommitHash = getGitCommitHash;

const MAX_WAIT_COUNT = 12;
const SERVER_WAIT_MS = 10 * 1000;
const DEFAULT_CONFIG = {
  route_prefix: '',
  secret: 'secret',
  sc_update_url_key_name: 'SC_UPDATE_URL',
  restart_function: _defaultRestartFunction,
  service_port: 80,
  http_proto: 'http',
  auth_middleware: false,
  repo_dir: process.env.PWD,
  console_log: console.log,
  error_log: console.error,
  update_launch_default: true,
  remove_old_target: true,
};
const g_config = {};
let g_gitCommitHash = false;
let g_updateHash = '';

function init(app, config) {
  Object.assign(g_config, DEFAULT_CONFIG, config);
  if (typeof g_config.route_prefix !== 'string') {
    throw 'server-control route_prefix required';
  }
  if (!g_config.remote_repo_prefix) {
    throw 'server-control remote_repo_prefix required';
  }
  g_config.route_prefix.replace(/\/$/, '');
  g_config.remote_repo_prefix.replace(/\/$/, '');

  _getAwsRegion();
  getGitCommitHash();
  const { route_prefix } = g_config;
  if (g_config.remove_old_target) {
    _removeOldTarget();
  }

  app.get(
    route_prefix + '/server_data',
    _parseQuery,
    body_parser.json(),
    body_parser.urlencoded({ extended: false }),
    cookie_parser(),
    _secretOrAuth,
    _serverData
  );
  app.get(
    route_prefix + '/group_data',
    _parseQuery,
    body_parser.json(),
    body_parser.urlencoded({ extended: false }),
    cookie_parser(),
    _secretOrAuth,
    _groupData
  );
  app.get(
    route_prefix + '/update_group',
    _parseQuery,
    body_parser.json(),
    body_parser.urlencoded({ extended: false }),
    cookie_parser(),
    _secretOrAuth,
    _updateGroup
  );
  app.get(
    route_prefix + '/update_server',
    _parseQuery,
    body_parser.json(),
    body_parser.urlencoded({ extended: false }),
    cookie_parser(),
    _secretOrAuth,
    _updateServer
  );
}
function _parseQuery(req, res, next) {
  if (typeof req.query === 'string') {
    const query = {};
    req.query.split('&').forEach((key_val) => {
      const split = key_val.split('=');
      query[split[0]] = split[1] || '';
    });
    req.query = query;
  }
  next();
}
function _secretOrAuth(req, res, next) {
  if (req.headers && req.headers['x-sc-secret'] === g_config.secret) {
    next();
  } else if (
    req.body &&
    req.body.secret &&
    req.body.secret === g_config.secret
  ) {
    next();
  } else if (
    req.cookies &&
    req.cookies.secret &&
    req.cookies.secret === g_config.secret
  ) {
    next();
  } else if (g_config.auth_middleware) {
    g_config.auth_middleware(req, res, next);
  } else {
    res.sendStatus(403);
  }
}
function _serverData(req, res) {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');

  getGitCommitHash((err, git_commit_hash) => {
    const body = {
      git_commit_hash,
      uptime: process.uptime(),
    };
    if (err) {
      res.status(500);
      body.err = err;
    }
    res.send(body);
  });
}

function _groupData(req, res) {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');

  _getGroupData((err, result) => {
    const body = {
      LATEST: result.latest || 'unknown',
      InstanceId: result.InstanceId || 'unknown',
      instance_list: result.instance_list,
    };

    if (result.auto_scale_group) {
      body.auto_scale_group = {
        AutoScalingGroupName: result.auto_scale_group.AutoScalingGroupName,
        LaunchTemplate: result.auto_scale_group.LaunchTemplate,
      };
      if (result.launch_template) {
        body.launch_template = result.launch_template;
      }
    }

    if (err) {
      res.status(500).send({ err, body });
    } else {
      res.send(body);
    }
  });
}

function _getGroupData(done) {
  const autoscaling = _getAutoscaling();
  const ec2 = _getEC2();
  let latest = false;
  let InstanceId = false;
  let asg = false;
  let instance_list = false;
  let launch_template = false;

  async.series(
    [
      (done) => {
        _getLatest((err, result) => {
          if (err) {
            _errorLog('_getGroupData: latest err:', err);
          }
          latest = result;
          done();
        });
      },
      (done) => {
        const meta = _getMetadataService();
        meta.request('/latest/meta-data/instance-id', (err, results) => {
          if (err) {
            _errorLog('_getGroupData: Failed to get instance id:', err);
          }
          InstanceId = results || '';
          done();
        });
      },
      (done) => {
        autoscaling.describeAutoScalingGroups({}, (err, data) => {
          if (err) {
            _errorLog('_getGroupData: find asg err:', err);
          } else {
            asg = data.AutoScalingGroups.find((group) => {
              return (
                group.AutoScalingGroupName === g_config.asg_name ||
                group.Instances.find((i) => i.InstanceId === InstanceId)
              );
            });
            if (!asg) {
              err = 'asg_not_found';
            }
          }
          done(err);
        });
      },
      (done) => {
        const opts = {
          InstanceIds: asg.Instances.map((i) => i.InstanceId),
        };
        ec2.describeInstances(opts, (err, results) => {
          if (err) {
            _errorLog('_getGroupData: describeInstances err:', err);
          } else {
            instance_list = [];
            results.Reservations.forEach((reservation) => {
              reservation.Instances.forEach((i) => {
                instance_list.push({
                  InstanceId: i.InstanceId,
                  PrivateIpAddress: i.PrivateIpAddress,
                  PublicIpAddress: i.PublicIpAddress,
                  LaunchTime: i.LaunchTime,
                  ImageId: i.ImageId,
                  InstanceType: i.InstanceType,
                  State: i.State,
                });
              });
            });
          }
          done(err);
        });
      },
      (done) => {
        const list = instance_list.filter((i) => i.State.Name === 'running');
        async.each(
          list,
          (instance, done) => {
            _getServerData(instance, (err, body) => {
              instance.git_commit_hash = body && body.git_commit_hash;
              instance.uptime = body && body.uptime;
              done(err);
            });
          },
          done
        );
      },
      (done) => {
        const opts = {
          LaunchTemplateId: asg.LaunchTemplate.LaunchTemplateId,
          Versions: [asg.LaunchTemplate.Version],
        };
        ec2.describeLaunchTemplateVersions(opts, (err, data) => {
          if (err) {
            _errorLog('_getGroupData: launch template fetch error:', err);
          } else if (data && data.LaunchTemplateVersions.length === 0) {
            err = 'launch_template_not_found';
          } else {
            launch_template = data.LaunchTemplateVersions[0];
            const ud = launch_template.LaunchTemplateData.UserData;
            if (ud) {
              const s = Buffer.from(ud, 'base64').toString('utf8');
              launch_template.LaunchTemplateData.UserData = s;
            }
          }
          done(err);
        });
      },
    ],
    (err) => {
      const ret = {
        latest,
        InstanceId,
        auto_scale_group: asg,
        launch_template,
        instance_list,
      };
      done(err, ret);
    }
  );
}

function _getServerData(instance, done) {
  const proto = g_config.http_proto;
  const ip = instance.PrivateIpAddress;
  const port = g_config.service_port;
  const prefix = g_config.route_prefix;
  const url = `${proto}://${ip}:${port}${prefix}/server_data`;
  const opts = {
    strictSSL: false,
    url,
    method: 'GET',
    headers: {
      'x-sc-secret': g_config.secret,
    },
    json: {
      secret: g_config.secret,
    },
  };
  webRequest(opts, (err, body) => {
    if (err) {
      _errorLog('_getServerData: request err:', err);
    }
    done(err, body);
  });
}
function _updateServer(req, res) {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  const hash = req.body.hash || req.query.hash;
  if (hash) {
    _updateSelf(hash, (err) => {
      if (err) {
        res.status(500).send(err);
      } else {
        res.send('Restarting server');
        g_config.restart_function();
      }
    });
  } else {
    res.status(400).send('hash is required');
  }
}
function _updateSelf(hash, done) {
  const dir = g_config.repo_dir;
  const url = `${g_config.remote_repo_prefix}/${hash}.tar.gz`;
  const cmd = `cd ${dir} && ${__dirname}/../scripts/update_to_hash.sh ${url}`;
  child_process.exec(cmd, (err, stdout, stderr) => {
    if (err) {
      _errorLog(
        '_updateSelf: update_to_hash.sh failed with err:',
        err,
        'stdout:',
        stdout,
        'stderr:',
        stderr
      );
      err = 'update_failed';
    } else {
      g_updateHash = hash;
    }
    done(err);
  });
}
function _removeOldTarget() {
  const dir = g_config.repo_dir;
  const cmd = `${__dirname}/../scripts/remove_old_target.sh ${dir}`;
  child_process.exec(cmd, (err, stdout, stderr) => {
    if (err) {
      _errorLog(
        '_removeOldTarget: remove_old_target.sh failed with err:',
        err,
        'stdout:',
        stdout,
        'stderr:',
        stderr
      );
    }
  });
}

function _updateGroup(req, res) {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');

  const hash = req.body.hash || req.query.hash;
  if (hash) {
    const url = `${g_config.remote_repo_prefix}/${hash}.tar.gz`;
    const key_name = g_config.sc_update_url_key_name;
    const ami_id = req.body.ami_id || req.query.ami_id || false;

    const ec2 = _getEC2();
    let group_data = false;
    let old_data = '';
    let new_version;
    const server_result = {};
    async.series(
      [
        (done) => {
          _getGroupData((err, result) => {
            if (!err) {
              group_data = result;
              const data = result.launch_template.LaunchTemplateData.UserData;
              data.split('\n').forEach((line) => {
                if (line.length && line.indexOf(key_name) === -1) {
                  old_data += line + '\n';
                }
              });
            }
            done(err);
          });
        },
        (done) => {
          headUrl(url, (err) => {
            if (err) {
              _errorLog('_updateGroup: head url:', url, 'err:', err);
              err = 'url_not_found';
            }
            done(err);
          });
        },
        (done) => {
          const new_data = `${old_data}${key_name}=${url}\n`;
          const opts = {
            LaunchTemplateId: group_data.launch_template.LaunchTemplateId,
            SourceVersion: String(group_data.launch_template.VersionNumber),
            LaunchTemplateData: {
              UserData: Buffer.from(new_data, 'utf8').toString('base64'),
            },
          };
          if (ami_id) {
            opts.LaunchTemplateData.ImageId = ami_id;
          }
          ec2.createLaunchTemplateVersion(opts, (err, data) => {
            if (err) {
              _errorLog('_updateGroup: failed to create version, err:', err);
            } else {
              new_version = data.LaunchTemplateVersion.VersionNumber;
            }
            done(err);
          });
        },
        (done) => {
          if (g_config.update_launch_default) {
            const opts = {
              DefaultVersion: String(new_version),
              LaunchTemplateId: group_data.launch_template.LaunchTemplateId,
            };
            ec2.modifyLaunchTemplate(opts, function (err) {
              if (err) {
                _errorLog('_updateGroup: failed to update default, err:', err);
              }
              done(err);
            });
          } else {
            done();
          }
        },
        (done) => {
          console.log('update all');
          let group_err;
          async.each(
            group_data.instance_list,
            (instance, done) => {
              if (instance.InstanceId === group_data.InstanceId) {
                console.log('skip self:', instance.InstanceId);
                done();
              } else {
                console.log('update:', instance.InstanceId);
                _updateInstance(hash, instance, (err) => {
                  console.log('update done:', instance.InstanceId, err);
                  if (err) {
                    _errorLog(
                      '_updateGroup: update instance:',
                      instance.InstanceId,
                      'err:',
                      err
                    );
                    group_err = err;
                  }
                  server_result[instance.InstanceId] = err;
                  done();
                });
              }
            },
            () => done(group_err)
          );
        },
        (done) => {
          console.log('update self');
          _updateSelf(hash, (err) => {
            server_result[group_data.InstanceId] = err;
            done(err);
          });
        },
      ],
      (err) => {
        const body = {
          err,
          server_result,
          launch_template_version: new_version,
        };
        if (err) {
          res.status(500).send(body);
        } else {
          body._msg =
            'Successful updating all servers, restarting this server.';
          res.send(body);
          g_config.restart_function();
        }
      }
    );
  } else {
    res.status(400).send('hash is required');
  }
}
function _updateInstance(hash, instance, done) {
  async.series(
    [
      (done) => {
        const proto = g_config.http_proto;
        const ip = instance.PrivateIpAddress;
        const port = g_config.service_port;
        const prefix = g_config.route_prefix;
        const url = `${proto}://${ip}:${port}${prefix}/update_server`;
        const opts = {
          strictSSL: false,
          url,
          method: 'GET',
          headers: {
            'x-sc-secret': g_config.secret,
          },
          json: {
            hash,
            secret: g_config.secret,
          },
        };
        console.log('_updateInstance:', instance.InstanceId);
        webRequest(opts, done);
      },
      (done) => _waitForServer({ instance, hash }, done),
    ],
    done
  );
}
function _waitForServer(params, done) {
  const { instance, hash } = params;
  let count = 0;

  async.forever(
    (done) => {
      count++;
      _getServerData(instance, (err, body) => {
        if (!err && body && body.git_commit_hash === hash) {
          done('stop');
        } else if (count > MAX_WAIT_COUNT) {
          done('too_many_tries');
        } else {
          setTimeout(done, SERVER_WAIT_MS);
        }
      });
    },
    (err) => {
      if (err === 'stop') {
        err = null;
      }
      done(err);
    }
  );
}

function _getLatest(done) {
  const url = g_config.remote_repo_prefix + '/LATEST';
  fetchFileContents(url, (err, body) => {
    done(err, body && body.trim());
  });
}
function getGitCommitHash(done) {
  if (g_gitCommitHash) {
    done && done(null, g_gitCommitHash);
  } else {
    const file = pathJoin(g_config.repo_dir, '.git_commit_hash');
    fs.readFile(file, 'utf8', (err, result) => {
      if (!err && !result) {
        err = 'no_result';
      }
      if (err) {
        _errorLog('getGitCommitHash: err:', err, 'file:', file);
      } else {
        g_gitCommitHash = result.trim();
      }
      done && done(err, g_gitCommitHash);
    });
  }
}
function _getAwsRegion() {
  if (!g_config.region) {
    const meta = _getMetadataService();
    meta.request(
      '/latest/dynamic/instance-identity/document',
      (err, results) => {
        if (err) {
          _errorLog('_getAwsRegion: metadata err:', err);
        } else {
          try {
            const json = JSON.parse(results);
            if (json && json.region) {
              g_config.region = json.region;
            }
          } catch (e) {
            _errorLog('_getAwsRegion: threw:', e);
          }
        }
      }
    );
  }
}
function _getMetadataService() {
  const opts = g_config.metadata_opts || {};
  return new AWS.MetadataService(opts);
}
function _getAutoscaling() {
  return new AWS.AutoScaling({ region: g_config.region });
}
function _getEC2() {
  return new AWS.EC2({ region: g_config.region });
}
function _errorLog(...args) {
  g_config.error_log(...args);
}
function _defaultRestartFunction() {
  g_config.console_log(
    'server-control: updated to: ',
    g_updateHash,
    'restarting...'
  );
  setTimeout(function () {
    process.exit(0);
  }, 100);
}
