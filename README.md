# server-control-s3

* create AMI with supervisor, git and node
* create user node with home in /var/node
* clone your project

sample config to add to your app:

```javascript

sc.init(app, {
	prefix: '/',
    repo_dir: '/var/node/project',
    secret: "update-secret"
});

```

* assign an IAM role with the following configuration:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Stmt1412101976000",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances"
      ],
      "Resource": [
        "*"
      ]
    },
    {
      "Sid": "Stmt1412102095000",
      "Effect": "Allow",
      "Action": [
        "autoscaling:CreateLaunchConfiguration",
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeLaunchConfigurations",
        "autoscaling:UpdateAutoScalingGroup"
      ],
      "Resource": [
        "*"
      ]
    }
  ]
}
```

* launch!
