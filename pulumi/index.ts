import * as aws from '@pulumi/aws';
import * as awsNative from '@pulumi/aws-native';
import * as awsx from '@pulumi/awsx';
import * as pulumi from '@pulumi/pulumi';
import * as std from '@pulumi/std';
import * as path from 'node:path';

import {
  VPC_NAME,
  SUBNET_NAME,
  SERVER_AMI_ID,
  CODE_BUCKET,
  SC_REPO_DIR,
  SC_UPDATE_URL,
}  from './config';

const server_control = new aws.iam.Policy('server-control-test', {
  path: '/',
  name: 'server-control-test',
  description: 'server-control-test',
  policy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['ec2:DescribeInstances'],
        Resource: ['*'],
      },
      {
        Effect: 'Allow',
        Action: [
          'ec2:DescribeLaunchTemplateVersions',
          'ec2:ModifyLaunchTemplate',
          'ec2:CreateLaunchTemplateVersion',
        ],
        Resource: ['*'],
      },
      {
        Effect: 'Allow',
        Action: ['autoscaling:DescribeAutoScalingGroups'],
        Resource: ['*'],
      },
    ],
  }),
});
const code_read = new aws.iam.Policy('server-control-test-code-read', {
  path: '/',
  name: 'server-control-test-code-read',
  description: 'server-control-test-code-read',
  policy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${CODE_BUCKET}/*`,
      },
      {
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: `arn:aws:s3:::${CODE_BUCKET}`,
      },
    ],
  }),
});

const role = new aws.iam.Role('server-control-test-role', {
  name: 'server-control-test-role',
  description: 'server-control-test-role',
  path: '/',
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'ec2.amazonaws.com' },
        Action: 'sts:AssumeRole',
      },
    ],
  }),
  managedPolicyArns: [
    code_read.arn,
    server_control.arn,
  ],
});
const profile = new aws.iam.InstanceProfile('server-control-test-profile', {
  name: 'server-control-test-profile',
  role: role.name,
});

const vpc = aws.ec2.getVpcOutput({ tags: { Name: VPC_NAME } });
const subnet = aws.ec2.getSubnetOutput({
  vpcId: vpc.id,
  tags: { Name: SUBNET_NAME },
});

const group_server = new aws.ec2.SecurityGroup('server-control-test-sg', {
  description: 'Server Control Test',
  vpcId: vpc.id,
  ingress: [
    {
      description: 'ssh',
      fromPort: 22,
      toPort: 22,
      protocol: 'tcp',
      cidrBlocks: [vpc.cidrBlock],
    },
    {
      description: 'http',
      fromPort: 80,
      toPort: 80,
      protocol: 'tcp',
      cidrBlocks: [vpc.cidrBlock],
    },
  ],
  egress: [
    {
      fromPort: 0,
      toPort: 0,
      protocol: '-1',
      cidrBlocks: ['0.0.0.0/0'],
      ipv6CidrBlocks: ['::/0'],
    },
  ],
  tags: {
    Name: 'server-control-test-sg',
  },
});

const launch_template = new aws.ec2.LaunchTemplate('server-control-test-lt', {
  updateDefaultVersion: true,
  creditSpecification: {
    cpuCredits: 'unlimited',
  },
  iamInstanceProfile: { arn: profile.arn },
  imageId: SERVER_AMI_ID,
  instanceInitiatedShutdownBehavior: 'terminate',
  keyName: 'jlake',
  metadataOptions: {
    httpEndpoint: 'enabled',
    httpProtocolIpv6: 'enabled',
    httpTokens: 'optional',
  },
  tagSpecifications: [
    {
      resourceType: 'instance',
      tags: {
        Name: 'server-control-test-auto',
      },
    },
  ],
  userData: Buffer.from(
`
SC_REPO_DIR=${SC_REPO_DIR}
SC_UPDATE_URL=${SC_UPDATE_URL}
`,
    'utf8'
  ).toString('base64'),
  vpcSecurityGroupIds: [group_server.id],
});

export const asg = new aws.autoscaling.Group('server-control-test-asg', {
  desiredCapacity: 1,
  maxSize: 1,
  minSize: 1,
  vpcZoneIdentifiers: [subnet.id],
  mixedInstancesPolicy: {
    instancesDistribution: {
      onDemandBaseCapacity: 0,
      onDemandPercentageAboveBaseCapacity: 0,
      onDemandAllocationStrategy: 'lowest-price',
      spotAllocationStrategy: 'lowest-price',
    },
    launchTemplate: {
      launchTemplateSpecification: {
        launchTemplateId: launch_template.id,
        version: '$Default',
      },
      overrides: [
        {
          instanceType: 't4g.nano',
          weightedCapacity: '1',
        },
        {
          instanceType: 't4g.micro',
          weightedCapacity: '1',
        },
        {
          instanceType: 't4g.small',
          weightedCapacity: '1',
        },
        {
          instanceType: 't4g.medium',
          weightedCapacity: '1',
        },
        {
          instanceType: 't4g.large',
          weightedCapacity: '1',
        },
      ],
    },
  },
});
