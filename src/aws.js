const AWS = require('aws-sdk');
const core = require('@actions/core');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label, config) {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  } else {
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}',
      'curl -O -L https://github.com/actions/runner/releases/download/v2.312.0/actions-runner-linux-${RUNNER_ARCH}-2.312.0.tar.gz',
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.312.0.tar.gz',
      'export RUNNER_ALLOW_RUNASROOT=1',
      'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  }
}

async function runEc2Instance(ec2, params) {  
  try {
    const result = await ec2.runInstances(params).promise();
    const ec2InstanceId = result.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function startEc2Instance(label, githubRegistrationToken, config) {
  const ec2 = new AWS.EC2();

  const userData = buildUserDataScript(githubRegistrationToken, label, config);

  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
    SubnetId: config.input.subnetId,
    SecurityGroupIds: [config.input.securityGroupId],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: config.tagSpecifications,
  };

  if (config.input.ec2LaunchTemplate) {
    params.LaunchTemplate = {
      LaunchTemplateName: config.input.ec2LaunchTemplate
    };
  }

  const vpcId = config.input.vpcId;

  if (!vpcId) {
    return await runEc2Instance(ec2, params);
  }

  const filters = {
    Filters: [
      {
        Name: "vpc-id",
        Values: [vpcId]
      }
    ]
  };
 
  const subnets = (await ec2.describeSubnets(filters).promise()).Subnets.map(s => s.SubnetId)

  if (subnets.length == 0) {
    throw new Error('Did not find any subnets in the provided VPC');
  }
  
  for (const subnetId of subnets) {
    params.SubnetId = subnetId;
    try {
      return await runEc2Instance(ec2, params);
    } catch (error) {	
      core.error(error);
      core.error('Retrying with next subnet...');
    }
  }

  throw new Error("Instance failed to launch in all subnets");
}

async function terminateEc2Instance(ec2InstanceId) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await ec2.terminateInstances(params).promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await ec2.waitFor('instanceRunning', params).promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

async function getSecretsManagerValue(secretsManagerId) {
  const secretsManager = new AWS.SecretsManager();

  const params = {
    SecretId: secretsManagerId
  };

  try {
    const result = await secretsManager.getSecretValue(params).promise();
    return result.SecretString;
  } catch (error) {
    core.error(`Error retrieving AWS Secrets Manager value: ${secretsManagerId}`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
  getSecretsManagerValue
};
