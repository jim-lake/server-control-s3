const asyncEach = require('async/each');
const asyncForever = require('async/forever');
const asyncSeries = require('async/series');

const {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
} = require('@aws-sdk/client-auto-scaling');
const {
  EC2Client,
  DescribeInstancesCommand,
  DescribeLaunchTemplateVersionsCommand,
  CreateLaunchTemplateVersionCommand,
  ModifyLaunchTemplateCommand,
} = require('@aws-sdk/client-ec2');
const child_process = require('node:child_process');
const fs = require('node:fs');
const { join: pathJoin } = require('node:path');
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

  asyncSeries([
    (done) => {
      _getAwsRegion(done);
    },
    (done) => {
      getGitCommitHash();
      const { route_prefix } = g_config;
      if (g_config.remove_old_target) {
        _removeOldTarget();
      }

      app.all(
        route_prefix + '/server_data',
        _parseQuery,
        _secretOrAuth,
        _serverData
      );
      app.all(
        route_prefix + '/group_data',
        _parseQuery,
        _secretOrAuth,
        _groupData
      );
      app.all(
        route_prefix + '/update_group',
        _parseQuery,
        _secretOrAuth,
        _updateGroup
      );
      app.all(
        route_prefix + '/update_server',
        _parseQuery,
        _secretOrAuth,
        _updateServer
      );
      done();
    },
  ]);
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

  asyncSeries(
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
        const opts = {
          url: 'http://169.254.169.254/latest/meta-data/instance-id',
          ...(g_config.metadata_opts || {}),
        };
        webRequest(opts, (err, results) => {
          if (err) {
            _errorLog('_getGroupData: Failed to get instance id:', err);
          }
          InstanceId = results || '';
          done();
        });
      },
      (done) => {
        const command = new DescribeAutoScalingGroupsCommand({});
        autoscaling.send(command).then(
          (data) => {
            asg = data.AutoScalingGroups.find((group) => {
              return (
                group.AutoScalingGroupName === g_config.asg_name ||
                group.Instances.find((i) => i.InstanceId === InstanceId)
              );
            });
            if (!asg) {
              _errorLog('_getGroupData: asg not found:', g_config.asg_name);
              done('asg_not_found');
            } else {
              done();
            }
          },
          (err) => {
            _errorLog('_getGroupData: find asg err:', err);
            done(err);
          }
        );
      },
      (done) => {
        const opts = {
          InstanceIds: asg.Instances.map((i) => i.InstanceId),
        };
        const command = new DescribeInstancesCommand(opts);
        ec2.send(command).then(
          (results) => {
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
            done();
          },
          (err) => {
            _errorLog('_getGroupData: describeInstances err:', err);
            done(err);
          }
        );
      },
      (done) => {
        const list = instance_list.filter((i) => i.State.Name === 'running');
        asyncEach(
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
        const lt =
          asg.LaunchTemplate ||
          asg.MixedInstancesPolicy?.LaunchTemplate?.LaunchTemplateSpecification;
        const opts = {
          LaunchTemplateId: lt?.LaunchTemplateId,
          Versions: [lt?.Version],
        };
        const command = new DescribeLaunchTemplateVersionsCommand(opts);
        ec2.send(command).then(
          (data) => {
            if (data?.LaunchTemplateVersions?.length > 0) {
              launch_template = data.LaunchTemplateVersions[0];
              const ud = launch_template.LaunchTemplateData.UserData;
              if (ud) {
                const s = Buffer.from(ud, 'base64').toString('utf8');
                launch_template.LaunchTemplateData.UserData = s;
              }
              done();
            } else {
              done('launch_template_not_found');
            }
          },
          (err) => {
            _errorLog('_getGroupData: launch template fetch error:', err);
            done(err);
          }
        );
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
    asyncSeries(
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
          headUrl(url, { region: g_config.region }, (err) => {
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
          const command = new CreateLaunchTemplateVersionCommand(opts);
          ec2.send(command).then(
            (data) => {
              new_version = data.LaunchTemplateVersion.VersionNumber;
              done();
            },
            (err) => {
              _errorLog('_updateGroup: failed to create version, err:', err);
              done(err);
            }
          );
        },
        (done) => {
          if (g_config.update_launch_default) {
            const opts = {
              DefaultVersion: String(new_version),
              LaunchTemplateId: group_data.launch_template.LaunchTemplateId,
            };
            const command = new ModifyLaunchTemplateCommand(opts);
            ec2.send(command).then(
              () => {
                done();
              },
              (err) => {
                _errorLog('_updateGroup: failed to update default, err:', err);
                done(err);
              }
            );
          } else {
            done();
          }
        },
        (done) => {
          let group_err;
          asyncEach(
            group_data.instance_list,
            (instance, done) => {
              if (instance.InstanceId === group_data.InstanceId) {
                done();
              } else {
                _updateInstance(hash, instance, (err) => {
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
  asyncSeries(
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

  asyncForever(
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
  fetchFileContents(url, { region: g_config.region }, (err, body) => {
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
function _getAwsRegion(done) {
  if (g_config.region) {
    return done();
  }
  const opts = {
    url: 'http://169.254.169.254/latest/dynamic/instance-identity/document',
    ...(g_config.metadata_opts || {}),
  };
  webRequest(opts, (err, results) => {
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
    done();
  });
}

function _getAutoscaling() {
  return new AutoScalingClient({ region: g_config.region });
}
function _getEC2() {
  return new EC2Client({ region: g_config.region });
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
