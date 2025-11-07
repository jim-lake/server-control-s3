import asyncEach from 'async/each';
import asyncForever from 'async/forever';
import asyncSeries from 'async/series';
import type { Request, Response, NextFunction } from 'express';

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
const SERVER_UPDATE_TIMEOUT = 2 * 60 * 1000;

export interface Config {
  secret: string;
  routePrefix: string;
  updateUrlKeyName: string;
  restartFunction: () => void;
  port: number;
  httpProto: string;
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void;
  repoDir: string;
  consoleLog: (...args: any[]) => void;
  errorLog: (...args: any[]) => void;
  updateLaunchDefault: boolean;
  removeOldTarget: boolean;
  remoteRepoPrefix?: string;
  metadataOpts?: any;
  asgName?: string;
  region?: string;
}
const DEFAULT_CONFIG: Config = {
  secret: 'secret',
  routePrefix: '',
  updateUrlKeyName: 'SC_UPDATE_URL',
  restartFunction: _defaultRestartFunction,
  port: 80,
  httpProto: 'http',
  repoDir: process.env.PWD || '.',
  consoleLog: console.log,
  errorLog: console.error,
  updateLaunchDefault: true,
  removeOldTarget: true,
};
const g_config: Config = {} as any;
let g_gitCommitHash: string | boolean = false;
let g_updateHash = '';

export function init(router: any, config: Partial<Config>) {
  Object.assign(g_config, DEFAULT_CONFIG, config);
  if (!g_config.remoteRepoPrefix) {
    throw 'server-control remote_repo_prefix required';
  }

  _getAwsRegion(() => {});
  getGitCommitHash(() => {});
  if (g_config.removeOldTarget) {
    _removeOldTarget();
  }
  router.use(_secretOrAuth);
  router.all('/server_data', _serverData);
  router.all('/group_data', _groupData);
  router.all('/update_group', _updateGroup);
  router.all('/update_server', _updateServer);
}
function _secretOrAuth(req: Request, res: Response, next: NextFunction) {
  if (req.headers && req.headers['x-sc-secret'] === g_config.secret) {
    next();
  } else if (req.body?.secret === g_config.secret) {
    next();
  } else if (req.cookies?.secret === g_config.secret) {
    next();
  } else if (g_config.authMiddleware) {
    g_config.authMiddleware(req, res, next);
  } else {
    res.sendStatus(403);
  }
}
function _serverData(req: Request, res: Response) {
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
function _groupData(req: Request, res: Response) {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');

  _getGroupData((err, result) => {
    const body: {
      LATEST: any;
      InstanceId: any;
      InstanceList: any;
      AutoScaleGroup?: any;
      LaunchTemplate?: any;
    } = {
      LATEST: result.latest || 'unknown',
      InstanceId: result.InstanceId || 'unknown',
      InstanceList: result.instance_list,
    };

    if (result.auto_scale_group) {
      body.AutoScaleGroup = {
        AutoScalingGroupName: result.auto_scale_group.AutoScalingGroupName,
        LaunchTemplate: result.auto_scale_group.LaunchTemplate,
      };
      if (result.launch_template) {
        body.LaunchTemplate = result.launch_template;
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
          ...(g_config.metadataOpts || {}),
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
                group.AutoScalingGroupName === g_config.asgName ||
                group.Instances.find((i: any) => i.InstanceId === InstanceId)
              );
            });
            if (!asg) {
              _errorLog('_getGroupData: asg not found:', g_config.asgName);
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
  const proto = g_config.httpProto;
  const ip = instance.PrivateIpAddress;
  const port = g_config.port;
  const prefix = g_config.routePrefix;
  const url = `${proto}://${ip}:${port}${prefix}/server_data`;
  const opts = {
    strictSSL: false,
    url,
    method: 'GET',
    headers: { 'x-sc-secret': g_config.secret },
    json: { secret: g_config.secret },
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
  const hash = req.body?.hash ?? req.query.hash;
  if (hash) {
    _updateSelf(hash, (err) => {
      if (err) {
        res.status(500).send(err);
      } else {
        res.send('Restarting server');
        g_config.restartFunction();
      }
    });
  } else {
    res.status(400).send('hash is required');
  }
}
function _updateSelf(hash: string, done: (err: any) => void) {
  const dir = g_config.repoDir;
  const url = `${g_config.remoteRepoPrefix}/${hash}.tar.gz`;
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
  const dir = g_config.repoDir;
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

function _updateGroup(req: Request, res: Response) {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');

  const hash = req.body?.hash ?? req.query.hash;
  if (hash) {
    const url = `${g_config.remoteRepoPrefix}/${hash}.tar.gz`;
    const key_name = g_config.updateUrlKeyName;
    const ami_id = req.body?.ami_id ?? req.query.ami_id ?? false;

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
          if (g_config.updateLaunchDefault) {
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
          g_config.restartFunction();
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
        const proto = g_config.httpProto;
        const ip = instance.PrivateIpAddress;
        const port = g_config.port;
        const prefix = g_config.routePrefix;
        const url = `${proto}://${ip}:${port}${prefix}/update_server`;
        const opts = {
          strictSSL: false,
          url,
          method: 'GET',
          headers: { 'x-sc-secret': g_config.secret },
          timeout: SERVER_UPDATE_TIMEOUT,
          json: { hash, secret: g_config.secret },
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
  const url = g_config.remoteRepoPrefix + '/LATEST';
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
    const file = pathJoin(g_config.repoDir, '.git_commit_hash');
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
    ...(g_config.metadataOpts || {}),
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
  g_config.errorLog(...args);
}
function _defaultRestartFunction() {
  g_config.consoleLog(
    'server-control: updated to: ',
    g_updateHash,
    'restarting...'
  );
  setTimeout(function () {
    process.exit(0);
  }, 100);
}
