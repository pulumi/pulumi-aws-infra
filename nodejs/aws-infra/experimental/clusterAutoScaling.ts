// Copyright 2016-2018, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import * as mod from ".";

import { Overwrite, sha1hash } from "./../utils";

export class ClusterAutoScalingLaunchConfiguration extends pulumi.ComponentResource {
    public readonly instance: aws.ec2.LaunchConfiguration;

    public readonly cluster: mod.Cluster;

    /**
     * Optional file system to mount.
     */
    public readonly fileSystem?: mod.ClusterFileSystem;

    public readonly instanceProfile: aws.iam.InstanceProfile;

    /**
     * Name to give the auto-scaling-group's cloudformation stack name.
     */
    public readonly stackName: pulumi.Output<string>;

    constructor(name: string,
                args: ClusterAutoScalingLaunchConfigurationArgs,
                opts: pulumi.ComponentResourceOptions = {}) {
        super("aws-infra.x.ClusterAutoScalingLaunchConfiguration", name, args, opts);

        const parentOpts = { parent: this };

        const cluster = args.cluster;

        // Create the full name of our CloudFormation stack here explicitly. Since the CFN stack
        // references the launch configuration and vice-versa, we use this to break the cycle.
        // TODO[pulumi/pulumi#381]: Creating an S3 bucket is an inelegant way to get a durable,
        // unique name.
        const stackName = pulumi.output(args.stackName).apply(sn => sn || new aws.s3.Bucket(name, {}, parentOpts).id);

        // Use the instance provided, or create a new one.
        const instanceProfile = args.instanceProfile ||
            ClusterAutoScalingLaunchConfiguration.createInstanceProfile(
                name, /*assumeRolePolicy:*/ undefined, /*policyArns:*/ undefined, parentOpts);

        const fileSystem = args.fileSystem;

        const securityGroups =
            pulumi.output(args.securityGroups).apply(g => g || cluster.instanceSecurityGroups.map(g => g.id));
        const instance = new aws.ec2.LaunchConfiguration(name, {
            ...args,
            securityGroups,
            imageId: getEcsAmiId(args.ecsOptimizedAMIName),
            instanceType: pulumi.output(args.instanceType).apply(t => t || "t2.micro"),
            iamInstanceProfile: instanceProfile.id,
            enableMonitoring: pulumi.output(args.enableMonitoring).apply(b => b !== undefined ? b : true),
            placementTenancy: pulumi.output(args.placementTenancy).apply(t => t || "default"),
            rootBlockDevice: pulumi.output(args.rootBlockDevice).apply(d => d || defaultRootBlockDevice),
            ebsBlockDevices: pulumi.output(args.ebsBlockDevices).apply(d => d || defaultEbsBlockDevices),
            userData: getInstanceUserData(cluster, args, stackName),
        }, parentOpts);

        this.instance = instance;
        this.cluster = cluster;
        this.stackName = stackName;
        this.instanceProfile = instanceProfile;
        this.fileSystem = fileSystem;

        this.registerOutputs({
            instance,
            cluster,
            stackName,
            instanceProfile,
            fileSystem,
        });
    }

    public static defaultInstanceProfilePolicyDocument(): aws.iam.PolicyDocument {
        return {
            Version: "2012-10-17",
            Statement: [{
                Action: [
                    "sts:AssumeRole",
                ],
                Effect: "Allow",
                Principal: {
                    Service: [ "ec2.amazonaws.com" ],
                },
            }],
        };
    }

    public static defaultInstanceProfilePolicyARNs() {
        return [aws.iam.AmazonEC2ContainerServiceforEC2Role, aws.iam.AmazonEC2ReadOnlyAccess];
    }

    /**
     * Creates the [instanceProfile] for a [ClusterAutoScalingLaunchConfiguration] if not provided
     * explicitly. If [assumeRolePolicy] is provided it will be used when creating the task,
     * otherwise [defaultInstanceProfilePolicyDocument] will be used.  If [policyArns] are provided,
     * they will be used to create [RolePolicyAttachment]s for the Role.  Otherwise,
     * [defaultInstanceProfilePolicyARNs] will be used.
     */
    public static createInstanceProfile(
        name: string,
        assumeRolePolicy?: string | aws.iam.PolicyDocument,
        policyArns?: string[],
        opts?: pulumi.ResourceOptions) {

        const { role, policies } = mod.createRoleAndPolicies(
            name,
            assumeRolePolicy || ClusterAutoScalingLaunchConfiguration.defaultInstanceProfilePolicyDocument(),
            policyArns || ClusterAutoScalingLaunchConfiguration.defaultInstanceProfilePolicyARNs(),
            opts);

        return new aws.iam.InstanceProfile(name, { role }, {...opts, dependsOn: policies });
    }
}

(<any>ClusterAutoScalingLaunchConfiguration).doNotCapture = true;

const defaultRootBlockDevice = {
    volumeSize: 8, // GiB
    volumeType: "gp2", // default is "standard"
    deleteOnTermination: true,
};

const defaultEbsBlockDevices = [{
        // Swap volume
        deviceName: "/dev/xvdb",
        volumeSize: 5, // GiB
        volumeType: "gp2", // default is "standard"
        deleteOnTermination: true,
    }, {
        // Docker image and metadata volume
        deviceName: "/dev/xvdcz",
        volumeSize: 50, // GiB
        volumeType: "gp2",
        deleteOnTermination: true,
    }];

function getInstanceProfile(
        name: string, opts: pulumi.ResourceOptions) {

    const instanceRole = new aws.iam.Role(name, {
        assumeRolePolicy: JSON.stringify(ClusterAutoScalingLaunchConfiguration.defaultInstanceProfilePolicyDocument()),
    }, opts);

    const policyARNs = ClusterAutoScalingLaunchConfiguration.defaultInstanceProfilePolicyARNs();
    const instanceRolePolicies: aws.iam.RolePolicyAttachment[] = [];
    for (let i = 0; i < policyARNs.length; i++) {
        const policyARN = policyARNs[i];

        instanceRolePolicies.push(new aws.iam.RolePolicyAttachment(`${name}-${sha1hash(policyARN)}`, {
            role: instanceRole,
            policyArn: policyARN,
        }, opts));
    }

    return new aws.iam.InstanceProfile(name, {
        role: instanceRole,
    }, {...opts, dependsOn: instanceRolePolicies});
}


// http://docs.aws.amazon.com/AmazonECS/latest/developerguide/container_agent_versions.html
async function getEcsAmiId(name?: string): Promise<string> {
    // If a name was not provided, use the latest recommended version.
    if (!name) {
        // https://docs.aws.amazon.com/AmazonECS/latest/developerguide/retrieve-ecs-optimized_AMI.html
        const ecsRecommendedAMI = await aws.ssm.getParameter({
            name: "/aws/service/ecs/optimized-ami/amazon-linux/recommended",
        });
        return JSON.parse(ecsRecommendedAMI.value).image_id;
    }

    // Else, if a name was provided, look it up and use that imageId.
    const result: aws.GetAmiResult = await aws.getAmi({
        filters: [
            {
                name: "name",
                values: [ name ],
            },
            {
                name: "owner-id",
                values: [ "591542846629" ], // Amazon
            },
        ],
        mostRecent: true,
    });

    return result.imageId;
}

// http://cloudinit.readthedocs.io/en/latest/topics/format.html#cloud-config-data
// ours seems inspired by:
// https://github.com/convox/rack/blob/023831d8/provider/aws/dist/rack.json#L1669
// https://github.com/awslabs/amazon-ecs-amazon-efs/blob/d92791f3/amazon-efs-ecs.json#L655
function getInstanceUserData(
    cluster: mod.Cluster,
    args: ClusterAutoScalingLaunchConfigurationArgs,
    cloudFormationStackName: pulumi.Output<string>) {

    const fileSystemId = args.fileSystem ? args.fileSystem.instance.id : undefined;
    const mountPath = args.fileSystem ? args.fileSystem.mountPath : undefined;

    return pulumi.all([cluster.instance.id, cloudFormationStackName, fileSystemId, mountPath])
                 .apply(([clusterId, cloudFormationStackName, fileSystemId, mountPath]) => {
        let fileSystemRuncmdBlock = "";

        if (fileSystemId) {
            // This string must be indented exactly as much as the block of commands it's inserted
            // into below!
            mountPath = mountPath || "/mnt/efs";

            // tslint:disable max-line-length
            fileSystemRuncmdBlock = `
                # Create EFS mount path
                mkdir ${mountPath}
                chown ec2-user:ec2-user ${mountPath}
                # Create environment variables
                EFS_FILE_SYSTEM_ID=${fileSystemId}
                DIR_SRC=$AWS_AVAILABILITY_ZONE.$EFS_FILE_SYSTEM_ID.efs.$AWS_REGION.amazonaws.com
                DIR_TGT=${mountPath}
                # Update /etc/fstab with the new NFS mount
                cp -p /etc/fstab /etc/fstab.back-$(date +%F)
                echo -e \"$DIR_SRC:/ $DIR_TGT nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2 0 0\" | tee -a /etc/fstab
                mount -a -t nfs4
                # Restart Docker
                docker ps
                service docker stop
                service docker start
            `;
        }

        return `#cloud-config
        repo_upgrade_exclude:
            - kernel*
        packages:
            - aws-cfn-bootstrap
            - aws-cli
            - nfs-utils
        mounts:
            - ['/dev/xvdb', 'none', 'swap', 'sw', '0', '0']
        bootcmd:
            - mkswap /dev/xvdb
            - swapon /dev/xvdb
            - echo ECS_CLUSTER='${clusterId}' >> /etc/ecs/ecs.config
            - echo ECS_ENGINE_AUTH_TYPE=docker >> /etc/ecs/ecs.config
        runcmd:
            # Set and use variables in the same command, since it's not obvious if
            # different commands will run in different shells.
            - |
                # Knock one letter off of availability zone to get region.
                AWS_AVAILABILITY_ZONE=$(curl -s 169.254.169.254/2016-09-02/meta-data/placement/availability-zone)
                AWS_REGION=$(echo $AWS_AVAILABILITY_ZONE | sed 's/.$//')

                ${fileSystemRuncmdBlock}

                # Disable container access to EC2 metadata instance
                # See http://docs.aws.amazon.com/AmazonECS/latest/developerguide/instance_IAM_role.html
                iptables --insert FORWARD 1 --in-interface docker+ --destination 169.254.169.254/32 --jump DROP
                service iptables save

                /opt/aws/bin/cfn-signal \
                    --region "\${AWS_REGION}" \
                    --stack "${cloudFormationStackName}" \
                    --resource Instances
        `;
    });
}

export class ClusterAutoScalingGroup extends pulumi.ComponentResource {
    public readonly instance: aws.cloudformation.Stack;

    public readonly cluster: mod.Cluster;

    /**
     * The launch configuration for this auto scaling group.
     */
    public readonly launchConfiguration: ClusterAutoScalingLaunchConfiguration;

    constructor(name: string,
                args: ClusterAutoScalingGroupArgs,
                opts: pulumi.ComponentResourceOptions = {}) {
        super("aws-infra:x:ClusterAutoScalingGroup", name, args, opts);

        const parentOpts = { parent: this };
        const cluster = args.cluster;

        let launchConfiguration: ClusterAutoScalingLaunchConfiguration;

        // Use the autoscaling config provided, otherwise just create a default one for this cluster.
        if (args.launchConfiguration) {
            launchConfiguration = args.launchConfiguration;
        }
        else {
            launchConfiguration = new ClusterAutoScalingLaunchConfiguration(
                name, args.launchConfigurationArgs || { cluster }, parentOpts);
        }

        this.instance = new aws.cloudformation.Stack(name, {
            ...args,
            name: launchConfiguration.stackName,
            templateBody: getCloudFormationTemplate(
                name,
                launchConfiguration.instance.id,
                cluster.network.subnetIds,
                args.templateParameters || {}),
        }, parentOpts);

        this.cluster = cluster;
        this.launchConfiguration = launchConfiguration;
    }
}

(<any>ClusterAutoScalingGroup).doNotCapture = true;

// TODO[pulumi/pulumi-aws/issues#43]: We'd prefer not to use CloudFormation, but it's the best way to implement
// rolling updates in an autoscaling group.
function getCloudFormationTemplate(
    instanceName: string,
    instanceLaunchConfigurationId: pulumi.Output<string>,
    subnetIds: pulumi.Input<string>[],
    parameters: pulumi.Input<TemplateParameters>): pulumi.Output<string> {

    const subnetIdsArray = pulumi.all(subnetIds);
    return pulumi.all([subnetIdsArray, instanceLaunchConfigurationId, parameters])
                 .apply(([subnetIdsArray, instanceLaunchConfigurationId, parameters]) => {

    const minSize = parameters.minSize !== undefined ? parameters.minSize : 2;
    const maxSize = parameters.maxSize !== undefined ? parameters.maxSize : 100;

    return `
    AWSTemplateFormatVersion: '2010-09-09'
    Outputs:
        Instances:
            Value: !Ref Instances
    Resources:
        Instances:
            Type: AWS::AutoScaling::AutoScalingGroup
            Properties:
                Cooldown: 300
                DesiredCapacity: ${minSize}
                HealthCheckGracePeriod: 120
                HealthCheckType: EC2
                LaunchConfigurationName: "${instanceLaunchConfigurationId}"
                MaxSize: ${maxSize}
                MetricsCollection:
                -   Granularity: 1Minute
                MinSize: ${minSize}
                VPCZoneIdentifier: ${JSON.stringify(subnetIdsArray)}
                Tags:
                -   Key: Name
                    Value: ${instanceName}
                    PropagateAtLaunch: true
            CreationPolicy:
                ResourceSignal:
                    Count: ${minSize}
                    Timeout: PT15M
            UpdatePolicy:
                AutoScalingRollingUpdate:
                    MaxBatchSize: 1
                    MinInstancesInService: ${minSize}
                    PauseTime: PT15M
                    SuspendProcesses:
                    -   ScheduledActions
                    WaitOnResourceSignals: true
    `;
                 });
}

export interface ClusterAutoScalingGroupArgs {
    /**
     * Cluster to create the autoscaling group for.
     */
    cluster: mod.Cluster;

    /**
     * The config to use when creating the auto scaling group.
     *
     * [launchConfiguration] or [launchConfigurationArgs] can be provided.  And, if either are
     * provided will be used as the launch configuration for the auto scaling group.
     *
     * If neither are provided, a default instance will be create by calling
     * [cluster.createAutoScalingConfig()].
     */
    launchConfiguration?: ClusterAutoScalingLaunchConfiguration;

    /**
     * The config to use when creating the auto scaling group.
     *
     * [launchConfiguration] or [launchConfigurationArgs] can be provided.  And, if either are
     * provided will be used as the launch configuration for the auto scaling group.
     *
     * If neither are provided, a default instance will be create by calling
     * [cluster.createAutoScalingConfig()].
     */
    launchConfigurationArgs?: ClusterAutoScalingLaunchConfigurationArgs;

    /**
     * Parameters to control the cloud formation stack template that is created.  If not provided
     * the defaults specified in TemplateParameters will be used.
     */
    templateParameters?: pulumi.Input<TemplateParameters>;
}

/**
 * Parameters to control the cloud formation stack template that is created.
 */
export interface TemplateParameters {
    /**
     * The minimum size of the cluster. Defaults to 2.
     */
    minSize?: number;
    /**
     * The maximum size of the cluster. Setting to 0 will prevent an EC2 AutoScalingGroup from being
     * created. Defaults to 100.
     */
    maxSize?: number;
}

// The shape we want for ClusterAutoScalingLaunchConfigurationArgs.  We don't export this as
// 'Overwrite' types are not pleasant to work with. However, they internally allow us to succinctly
// express the shape we're trying to provide. Code later on will ensure these types are compatible.
type OverwriteShape = Overwrite<aws.ec2.LaunchConfigurationArgs, {
    cluster: mod.Cluster;
    imageId?: never;
    userData?: never;
    stackName?: pulumi.Input<string>;
    instanceProfile?: aws.iam.InstanceProfile;
    fileSystem?: mod.ClusterFileSystem;
    securityGroups?: aws.ec2.LaunchConfiguration["securityGroups"];
    ecsOptimizedAMIName?: string;
    instanceType?: pulumi.Input<aws.ec2.InstanceType>;
    placementTenancy?: pulumi.Input<"default" | "dedicated">;
    rootBlockDevice?: aws.ec2.LaunchConfigurationArgs["rootBlockDevice"];
    ebsBlockDevices?: aws.ec2.LaunchConfigurationArgs["ebsBlockDevices"];
}>;

/**
 * The set of arguments when creating the launch configuration for a cluster's autoscaling group.
 */
export interface ClusterAutoScalingLaunchConfigurationArgs {
    // Values copied directly from aws.ec2.LaunchConfigurationArgs

    /**
     * Associate a public ip address with an instance in a VPC.
     */
    associatePublicIpAddress?: pulumi.Input<boolean>;
    /**
     * If true, the launched EC2 instance will be EBS-optimized.
     */
    ebsOptimized?: pulumi.Input<boolean>;
    /**
     * Enables/disables detailed monitoring. This is enabled by default.
     */
    enableMonitoring?: pulumi.Input<boolean>;
    /**
     * Customize Ephemeral (also known as
     * "Instance Store") volumes on the instance. See Block Devices below for details.
     */
    ephemeralBlockDevices?: pulumi.Input<pulumi.Input<{
        deviceName: pulumi.Input<string>;
        virtualName: pulumi.Input<string>;
    }>[]>;
    /**
     * The name attribute of the IAM instance profile to associate
     * with launched instances.
     */
    iamInstanceProfile?: pulumi.Input<string | aws.iam.InstanceProfile>;
    /**
     * The key name that should be used for the instance.
     */
    keyName?: pulumi.Input<string>;
    /**
     * The name of the launch configuration. If you leave
     * this blank, Terraform will auto-generate a unique name.
     */
    name?: pulumi.Input<string>;
    /**
     * Creates a unique name beginning with the specified
     * prefix. Conflicts with `name`.
     */
    namePrefix?: pulumi.Input<string>;
    /**
     * The maximum price to use for reserving spot instances.
     */
    spotPrice?: pulumi.Input<string>;
    /**
     * Can be used instead of `user_data` to pass base64-encoded binary data directly. Use this
     * instead of `user_data` whenever the value is not a valid UTF-8 string. For example,
     * gzip-encoded user data must be base64-encoded and passed via this argument to avoid
     * corruption.
     */
    userDataBase64?: pulumi.Input<string>;
    /**
     * The ID of a ClassicLink-enabled VPC. Only applies to EC2-Classic instances. (eg. `vpc-2730681a`)
     */
    vpcClassicLinkId?: pulumi.Input<string>;
    /**
     * The IDs of one or more security groups for the specified ClassicLink-enabled VPC (eg. `sg-46ae3d11`).
     */
    vpcClassicLinkSecurityGroups?: pulumi.Input<pulumi.Input<string>[]>;

    // Changes made to normal args type.

    /**
     * Cluster to create launch configuration for.
     */
    cluster: mod.Cluster;

    /**
     * The name of the stack the launch configuration will signal.
     */
    stackName?: pulumi.Input<string>;

    /**
     * The instance profile to use for the autoscaling group.  If not provided, a default one will
     * be created.
     */
    instanceProfile?: aws.iam.InstanceProfile;

    /**
     * Optional file system to mount.
     */
    fileSystem?: mod.ClusterFileSystem;

    /**
    * A list of associated security group IDS.  If not provided, the instanceSecurityGroup from the
    * cluster will be used.
    */
    securityGroups?: aws.ec2.LaunchConfiguration["securityGroups"];

    /**
     * The name of the ECS-optimzed AMI to use for the Container Instances in this cluster, e.g.
     * "amzn-ami-2017.09.l-amazon-ecs-optimized". Defaults to using the latest recommended ECS Linux
     * Optimized AMI, which may change over time and cause recreation of EC2 instances when new
     * versions are release. To control when these changes are adopted, set this parameter
     * explicitly to the version you would like to use.
     *
     * See http://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-optimized_AMI.html for
     * valid values.
     */
    ecsOptimizedAMIName?: string;

    /**
     * The size of instance to launch.  Defaults to t2.micro if unspecified.
     */
    instanceType?: pulumi.Input<aws.ec2.InstanceType>;

    /**
     * The tenancy of the instance. Valid values are `"default"` or `"dedicated"`, see
     * http://docs.aws.amazon.com/AutoScaling/latest/APIReference/API_CreateLaunchConfiguration.html
     * for more details.  Default is "default" if unspecified.
     */
    placementTenancy?: pulumi.Input<"default" | "dedicated">;

    /**
     * Customize details about the root block device of the instance. See Block Devices below for
     * details.
     *
     * If not provided, an 8gb 'gp2' root device will be created.  This device will be deleted upon
     * termination.
     */
    rootBlockDevice?: aws.ec2.LaunchConfigurationArgs["rootBlockDevice"];

    /**
     * Additional EBS block devices to attach to the instance.  See Block Devices below for details.
     *
     * If not provided, a 5gb 'gp2' device will be mounted at '/dev/xvdb' and a 50gb 'gp2' device
     * will be mounted at '/dev/xvdcz'.  Both devices will be deleted upon termination.
     */
    ebsBlockDevices?: aws.ec2.LaunchConfigurationArgs["ebsBlockDevices"];
}

// Make sure our exported args shape is compatible with the overwrite shape we're trying to provide.
let overwriteShape: OverwriteShape = undefined!;
let argsShape: ClusterAutoScalingLaunchConfigurationArgs = undefined!;
argsShape = overwriteShape;
overwriteShape = argsShape;
