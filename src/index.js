const async = require('async');
require('aws-sdk/lib/maintenance_mode_message').suppress = true;
const AWS = require('aws-sdk');
const body_parser = require('body-parser');
const child_process = require('child_process');
const cookie_parser = require('cookie-parser');
const fs = require('fs');
const { join: pathJoin } = require('path');
const { webRequest, fetchFileContents } = require('./request');

exports.init = init;

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
  repo_dir: '.',
  error_log: console.error,
};
const g_config = {};
let g_gitCommitHash = false;

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
  _getGitCommitHash();
  const { route_prefix } = g_config;

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

  _getGitCommitHash((err, git_commit_hash) => {
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
        launch_config: {
          LaunchConfigurationName:
            result.auto_scale_group.LaunchConfigurationName,
        },
      };
      if (result.launch_config) {
        body.auto_scale_group.launch_config.ImageId =
          result.launch_config.ImageId;
        body.auto_scale_group.launch_config.UserData =
          result.launch_config.UserData;
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
  let latest = false;
  let InstanceId = false;
  let asg = false;
  let instance_list = false;
  let launch_config = false;

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
        const autoscaling = _getAutoscaling();
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
        const autoscaling = _getAutoscaling();
        const opts = {
          LaunchConfigurationNames: [asg.LaunchConfigurationName],
        };
        autoscaling.describeLaunchConfigurations(opts, (err, data) => {
          if (err) {
            _errorLog('_getGroupData: launch config fetch error:', err);
          } else {
            if (data.LaunchConfigurations.length > 0) {
              launch_config = data.LaunchConfigurations[0];
              if (launch_config.UserData) {
                const s = Buffer.from(
                  launch_config.UserData,
                  'base64'
                ).toString('ascii');
                launch_config.UserData = s;
              } else {
                launch_config.UserData = '';
              }
            } else {
              err = 'launch_config_not_found';
            }
          }
          done(err);
        });
      },
      (done) => {
        const ec2 = _getEC2();
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
    ],
    (err) => {
      const ret = {
        latest,
        InstanceId,
        auto_scale_group: asg,
        launch_config,
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
  webRequest(opts, (err, response, body) => {
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
        g_config.restart_function();
        res.send('Restarting server');
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
    }
    done(err);
  });
}

function _updateGroup(req, res) {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');

  const hash = req.body.hash || req.query.hash;
  if (hash) {
    const url = `${g_config.remote_repo_prefix}/${hash}.tar.gz`;
    const key_name = g_config.sc_update_url_key_name;
    const ami_id = req.body.ami_id || req.query.ami_id || false;

    const autoscaling = _getAutoscaling();
    let service_data = false;
    let launch_config_name = false;
    let old_data = '';
    async.series(
      [
        (done) => {
          _getGroupData((err, result) => {
            if (!err) {
              service_data = result;
              const old_name = result.launch_config.LaunchConfigurationName;
              const match = old_name.match(/([^\d]*)(\d*)/);
              if (match.length < 3) {
                launch_config_name = old_name + '-2';
              } else {
                const new_index = parseInt(match[2]) + 1;
                launch_config_name = match[1] + new_index;
              }

              const data = result.launch_config.UserData;
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
          _updateSelf(hash, done);
        },
        (done) => {
          const new_data = `${old_data}${key_name}=${url}\n`;

          const lc = service_data.launch_config;
          const opts = {
            LaunchConfigurationName: launch_config_name,
            ImageId: ami_id || lc.ImageId,
            SecurityGroups: lc.SecurityGroups,
            BlockDeviceMappings: lc.BlockDeviceMappings,
            InstanceType: lc.InstanceType,
            InstanceMonitoring: lc.InstanceMonitoring,
            EbsOptimized: lc.EbsOptimized,
            AssociatePublicIpAddress: lc.AssociatePublicIpAddress,
            PlacementTenancy: lc.PlacementTenancy,
            InstanceId: service_data.InstanceId,
            UserData: Buffer.from(new_data, 'utf8').toString('base64'),
          };
          autoscaling.createLaunchConfiguration(opts, (err) => {
            if (err) {
              _errorLog('_updateGroup: failed to create lc, err:', err);
            }
            done(err);
          });
        },
        (done) => {
          const opts = {
            AutoScalingGroupName:
              service_data.auto_scale_group.AutoScalingGroupName,
            LaunchConfigurationName: launch_config_name,
          };
          autoscaling.updateAutoScalingGroup(opts, (err) => {
            if (err) {
              _errorLog('_updateGroup: failed to update asg, err:', err);
            }
            done(err);
          });
        },
        (done) => {
          async.each(
            service_data.instance_list,
            (instance, done) => {
              if (instance.InstanceId === service_data.InstanceId) {
                done();
              } else {
                _updateInstance(hash, instance, done);
              }
            },
            done
          );
        },
      ],
      (err) => {
        if (err) {
          res.status(500).send(err);
        } else {
          const body = {
            launch_config_name,
            _msg: 'Successful updating all servers, restarting this server.',
          };
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
        webRequest(opts, (err) => {
          if (err) {
            _errorLog('_updateInstance: request err:', err);
          }
          done(err);
        });
      },
      (done) => _waitForServer({ instance, hash }, done),
    ],
    done
  );
}
function _waitForServer(params, done) {
  const { instance, hash } = params;
  let found_hash = false;
  let count = 0;

  async.until(
    () => found_hash,
    (done) => {
      count++;
      _getServerData(instance, (err, body) => {
        if (!err && body && body.git_commit_hash === hash) {
          found_hash = true;
          done(null);
        } else if (count > MAX_WAIT_COUNT) {
          done('too_many_tires');
        } else {
          setTimeout(done, SERVER_WAIT_MS);
        }
      });
    },
    done
  );
}

function _getLatest(done) {
  const url = g_config.remote_repo_prefix + '/LATEST';
  fetchFileContents(url, (err, body) => {
    done(err, body && body.trim());
  });
}
function _getGitCommitHash(done) {
  if (g_gitCommitHash) {
    done && done(null, g_gitCommitHash);
  } else {
    const file = pathJoin(g_config.repo_dir, '.git_commit_hash');
    fs.readFile(file, 'utf8', (err, result) => {
      if (!err && !result) {
        err = 'no_result';
      }
      if (err) {
        _errorLog('_getGitCommitHash: err:', err, 'file:', file);
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
  console.log('Successful update, restarting server');
  setTimeout(function () {
    process.exit(0);
  }, 100);
}
