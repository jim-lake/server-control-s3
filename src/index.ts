import asyncEach from 'async/each';
import asyncForever from 'async/forever';
import asyncSeries from 'async/series';

import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeLaunchTemplateVersionsCommand,
  CreateLaunchTemplateVersionCommand,
  ModifyLaunchTemplateCommand,
} from '@aws-sdk/client-ec2';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import { join as pathJoin } from 'node:path';
import * as request from './request';

export default {
  init,
  getGitCommitHash,
};

const MAX_WAIT_COUNT = 12;
const SERVER_WAIT_MS = 10 * 1000;
export interface Config {
  route_prefix: string;
  secret: string;
  sc_update_url_key_name: string;
  restart_function: () => void;
  service_port: number;
  http_proto: string;
  auth_middleware: boolean | ((req: any, res: any, next: any) => void);
  repo_dir: string;
  console_log: (...args: any[]) => void;
  error_log: (...args: any[]) => void;
  update_launch_default: boolean;
  remove_old_target: boolean;
  remote_repo_prefix?: string;
  metadata_opts?: any;
  asg_name?: string;
  region?: string;
}

const DEFAULT_CONFIG: Config = {
  route_prefix: '',
  secret: 'secret',
  sc_update_url_key_name: 'SC_UPDATE_URL',
  restart_function: _defaultRestartFunction,
  service_port: 80,
  http_proto: 'http',
  auth_middleware: false,
  repo_dir: process.env.PWD || '.',
  console_log: console.log,
  error_log: console.error,
  update_launch_default: true,
  remove_old_target: true,
};
const g_config: Config = {} as any;
let g_gitCommitHash: string | boolean = false;
let g_updateHash = '';

export function init(app: any, config: Partial<Config>) {
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
    (done: (err?: any) => void) => {
      _getAwsRegion(done);
    },
    (done: (err?: any) => void) => {
      getGitCommitHash(() => {});
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
function _parseQuery(req: any, res: any, next: any) {
  if (typeof req.query === 'string') {
    const query: { [key: string]: string } = {};
    req.query.split('&').forEach((key_val: string) => {
      const split = key_val.split('=');
      query[split[0]] = split[1] || '';
    });
    req.query = query;
  }
  next();
}
function _secretOrAuth(req: any, res: any, next: any) {
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
  } else if (typeof g_config.auth_middleware === 'function') {
    g_config.auth_middleware(req, res, next);
  } else {
    res.sendStatus(403);
  }
}
function _serverData(req: any, res: any) {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');

  getGitCommitHash((err, git_commit_hash) => {
    const body: {
      git_commit_hash: string | undefined;
      uptime: number;
      err?: any;
    } = {
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

function _groupData(req: any, res: any) {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');

  _getGroupData((err, result) => {
    const body: {
      LATEST: any;
      InstanceId: any;
      instance_list: any;
      auto_scale_group?: any;
      launch_template?: any;
    } = {
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

function _getGroupData(done: (err: any, result?: any) => void) {
  const autoscaling = _getAutoscaling();
  const ec2 = _getEC2();
  let latest: string | boolean = false;
  let InstanceId = false;
  let asg: any = false;
  let instance_list: any[] = [];
  let launch_template: any = false;

  asyncSeries(
    [
      (done: (err?: any) => void) => {
        _getLatest((err, result) => {
          if (err) {
            _errorLog('_getGroupData: latest err:', err);
          }
          latest = result || false;
          done();
        });
      },
      (done: (err?: any) => void) => {
        const opts = {
          url: 'http://169.254.169.254/latest/meta-data/instance-id',
          ...(g_config.metadata_opts || {}),
        };
        request.webRequest(opts, (err: any, results: any) => {
          if (err) {
            _errorLog('_getGroupData: Failed to get instance id:', err);
          }
          InstanceId = results || '';
          done();
        });
      },
      (done: (err?: any) => void) => {
        const command = new DescribeAutoScalingGroupsCommand({});
        autoscaling.send(command).then(
          (data: any) => {
            asg = data.AutoScalingGroups.find((group: any) => {
              return (
                group.AutoScalingGroupName === g_config.asg_name ||
                group.Instances.find((i: any) => i.InstanceId === InstanceId)
              );
            });
            if (!asg) {
              _errorLog('_getGroupData: asg not found:', g_config.asg_name);
              done('asg_not_found');
            } else {
              done();
            }
          },
          (err: any) => {
            _errorLog('_getGroupData: find asg err:', err);
            done(err);
          }
        );
      },
      (done: (err?: any) => void) => {
        const opts = {
          InstanceIds: asg.Instances.map((i: any) => i.InstanceId),
        };
        const command = new DescribeInstancesCommand(opts);
        ec2.send(command).then(
          (results: any) => {
            instance_list = [];
            results.Reservations.forEach((reservation: any) => {
              reservation.Instances.forEach((i: any) => {
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
          (err: any) => {
            _errorLog('_getGroupData: describeInstances err:', err);
            done(err);
          }
        );
      },
      (done: (err?: any) => void) => {
        const list = instance_list.filter(
          (i: any) => i.State.Name === 'running'
        );
        asyncEach(
          list,
          (instance: any, done: (err?: any) => void) => {
            _getServerData(instance, (err, body) => {
              instance.git_commit_hash = body && body.git_commit_hash;
              instance.uptime = body && body.uptime;
              done(err);
            });
          },
          done
        );
      },
      (done: (err?: any) => void) => {
        const lt =
          asg.LaunchTemplate ||
          asg.MixedInstancesPolicy?.LaunchTemplate?.LaunchTemplateSpecification;
        const opts = {
          LaunchTemplateId: lt?.LaunchTemplateId,
          Versions: [lt?.Version],
        };
        const command = new DescribeLaunchTemplateVersionsCommand(opts);
        ec2.send(command).then(
          (data: any) => {
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
          (err: any) => {
            _errorLog('_getGroupData: launch template fetch error:', err);
            done(err);
          }
        );
      },
    ],
    (err: any) => {
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

function _getServerData(instance: any, done: (err: any, body?: any) => void) {
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
  request.webRequest(opts, (err: any, body: any) => {
    if (err) {
      _errorLog('_getServerData: request err:', err);
    }
    done(err, body);
  });
}
function _updateServer(req: any, res: any) {
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
function _updateSelf(hash: string, done: (err: any) => void) {
  const dir = g_config.repo_dir;
  const url = `${g_config.remote_repo_prefix}/${hash}.tar.gz`;
  const cmd = `cd ${dir} && ${__dirname}/../scripts/update_to_hash.sh ${url}`;
  child_process.exec(cmd, (err: any, stdout: any, stderr: any) => {
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
  child_process.exec(cmd, (err: any, stdout: any, stderr: any) => {
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

function _updateGroup(req: any, res: any) {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');

  const hash = req.body.hash || req.query.hash;
  if (hash) {
    const url = `${g_config.remote_repo_prefix}/${hash}.tar.gz`;
    const key_name = g_config.sc_update_url_key_name;
    const ami_id = req.body.ami_id || req.query.ami_id || false;

    const ec2 = _getEC2();
    let group_data: any = false;
    let old_data = '';
    let new_version: any;
    const server_result: { [key: string]: any } = {};
    asyncSeries(
      [
        (done: (err?: any) => void) => {
          _getGroupData((err, result) => {
            if (!err) {
              group_data = result;
              const data = result.launch_template.LaunchTemplateData.UserData;
              data.split('\n').forEach((line: string) => {
                if (line.length && line.indexOf(key_name) === -1) {
                  old_data += line + '\n';
                }
              });
            }
            done(err);
          });
        },
        (done: (err?: any) => void) => {
          request.headUrl(url, { region: g_config.region }, (err: any) => {
            if (err) {
              _errorLog('_updateGroup: head url:', url, 'err:', err);
              err = 'url_not_found';
            }
            done(err);
          });
        },
        (done: (err?: any) => void) => {
          const new_data = `${old_data}${key_name}=${url}\n`;
          const opts = {
            LaunchTemplateId: group_data.launch_template.LaunchTemplateId,
            SourceVersion: String(group_data.launch_template.VersionNumber),
            LaunchTemplateData: {
              UserData: Buffer.from(new_data, 'utf8').toString('base64'),
            },
          };
          if (ami_id) {
            (opts.LaunchTemplateData as any).ImageId = ami_id;
          }
          const command = new CreateLaunchTemplateVersionCommand(opts);
          ec2.send(command).then(
            (data: any) => {
              new_version = data.LaunchTemplateVersion.VersionNumber;
              done();
            },
            (err: any) => {
              _errorLog('_updateGroup: failed to create version, err:', err);
              done(err);
            }
          );
        },
        (done: (err?: any) => void) => {
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
              (err: any) => {
                _errorLog('_updateGroup: failed to update default, err:', err);
                done(err);
              }
            );
          } else {
            done();
          }
        },
        (done: (err?: any) => void) => {
          let group_err: any;
          asyncEach(
            group_data.instance_list,
            (instance: any, done: (err?: any) => void) => {
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
        (done: (err?: any) => void) => {
          _updateSelf(hash, (err) => {
            server_result[group_data.InstanceId] = err;
            done(err);
          });
        },
      ],
      (err: any) => {
        const body: {
          err: any;
          server_result: { [key: string]: any };
          launch_template_version: any;
          _msg?: string;
        } = {
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
function _updateInstance(
  hash: string,
  instance: any,
  done: (err: any) => void
) {
  asyncSeries(
    [
      (done: (err?: any) => void) => {
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
        request.webRequest(opts, done);
      },
      (done: (err?: any) => void) => _waitForServer({ instance, hash }, done),
    ],
    done
  );
}
function _waitForServer(params: any, done: (err: any) => void) {
  const { instance, hash } = params;
  let count = 0;

  asyncForever(
    (done: (err?: any) => void) => {
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
    (err: any) => {
      if (err === 'stop') {
        err = null;
      }
      done(err);
    }
  );
}

function _getLatest(done: (err: any, body?: string) => void) {
  const url = g_config.remote_repo_prefix + '/LATEST';
  request.fetchFileContents(
    url,
    { region: g_config.region },
    (err: any, body?: string) => {
      done(err, body && body.trim());
    }
  );
}
export function getGitCommitHash(done: (err: any, result?: string) => void) {
  if (typeof g_gitCommitHash === 'string') {
    done && done(null, g_gitCommitHash);
  } else {
    const file = pathJoin(g_config.repo_dir, '.git_commit_hash');
    fs.readFile(file, 'utf8', (err: any, result: string) => {
      if (!err && !result) {
        err = 'no_result';
      }
      if (err) {
        _errorLog('getGitCommitHash: err:', err, 'file:', file);
      } else {
        g_gitCommitHash = result.trim();
      }
      done && done(err, g_gitCommitHash as string);
    });
  }
}
function _getAwsRegion(done: (err?: any) => void) {
  if (g_config.region) {
    return done();
  }
  const opts = {
    url: 'http://169.254.169.254/latest/dynamic/instance-identity/document',
    ...(g_config.metadata_opts || {}),
  };
  request.webRequest(opts, (err: any, results: any) => {
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
function _errorLog(...args: any[]) {
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
