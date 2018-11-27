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

import * as utils from "../utils";

export class ClusterFileSystem extends pulumi.ComponentResource {
    public readonly instance: aws.efs.FileSystem;
    public readonly cluster: mod.Cluster;
    public readonly securityGroup: aws.ec2.SecurityGroup;
    public readonly mountTargets: aws.efs.MountTarget[];
    public readonly mountPath: pulumi.Output<string>;

    constructor(name: string,
                args: ClusterFileSystemArgs,
                opts: pulumi.CustomResourceOptions = {}) {
        super("aws-infra:x:ClusterFileSystem", name, {
            ...args,
        }, opts);

        const parentOpts = { parent: this };

        const cluster = args.cluster;
        const instance = new aws.efs.FileSystem(name, args, parentOpts);

        const mountTargets: aws.efs.MountTarget[] = [];
        const mountPath = pulumi.output(args.mountPath).apply(p => p || "/mnt/efs");

        // If requested, add EFS file system and mount targets in each subnet.

        const efsSecurityGroupName = `${name}-fs`;
        const securityGroup = args.securityGroup || new aws.ec2.SecurityGroup(efsSecurityGroupName, {
            vpcId: cluster.network.vpcId,
            ingress: [
                // Allow NFS traffic from the instance security group
                {
                    securityGroups: cluster.instanceSecurityGroups.map(g => g.id),
                    protocol: "TCP",
                    fromPort: 2049,
                    toPort: 2049,
                },
            ],
            tags: { Name: efsSecurityGroupName },
        }, parentOpts);

        const subnetIds = args.subnetIds || cluster.network.subnetIds;
        for (let i = 0; i < subnetIds.length; i++) {
            const subnetId = subnetIds[i];
            mountTargets.push(new aws.efs.MountTarget(`${name}-${i}`, {
                fileSystemId: instance.id,
                subnetId: subnetId,
                securityGroups: [ securityGroup.id ],
            }, parentOpts));
        }

        this.instance = instance;
        this.cluster = cluster;
        this.mountPath = mountPath;
        this.mountTargets = mountTargets;
        this.securityGroup = securityGroup;

        this.registerOutputs({
            instance,
            cluster,
            mountPath,
            mountTargets,
            securityGroup,
        });
    }
}

(<any>ClusterFileSystem).doNotCapture = true;

// The shape we want for ClusterFileSystemArgs.  We don't export this as 'Overwrite' types are not pleasant to
// work with. However, they internally allow us to succinctly express the shape we're trying to
// provide. Code later on will ensure these types are compatible.
type OverwriteShape = utils.Overwrite<aws.efs.FileSystemArgs, {
    cluster: mod.Cluster,
    securityGroup?: aws.ec2.SecurityGroup;
    subnetIds?: pulumi.Input<string>[];
    mountPath?: pulumi.Input<string>;
}>;

/**
 * Arguments for creating a file system for a cluster.
 */
export interface ClusterFileSystemArgs {
    // Properties from aws.efs.FileSystemArgs

    /**
     * A unique name (a maximum of 64 characters are allowed)
     * used as reference when creating the Elastic File System to ensure idempotent file
     * system creation. By default generated by Terraform. See [Elastic File System]
     * (http://docs.aws.amazon.com/efs/latest/ug/) user guide for more information.
     */
    creationToken?: pulumi.Input<string>;
    /**
     * If true, the disk will be encrypted.
     */
    encrypted?: pulumi.Input<boolean>;
    /**
     * The ARN for the KMS encryption key. When specifying kms_key_id, encrypted needs to be set to true.
     */
    kmsKeyId?: pulumi.Input<string>;
    /**
     * The file system performance mode. Can be either `"generalPurpose"` or `"maxIO"` (Default: `"generalPurpose"`).
     */
    performanceMode?: pulumi.Input<string>;
    /**
     * The throughput, measured in MiB/s, that you want to provision for the file system. Only
     * applicable with `throughput_mode` set to `provisioned`.
     */
    provisionedThroughputInMibps?: pulumi.Input<number>;
    /**
     * **DEPRECATED** (Optional) A reference name used when creating the
     * `Creation Token` which Amazon EFS uses to ensure idempotent file system creation. By
     * default generated by Terraform.
     */
    referenceName?: pulumi.Input<string>;
    /**
     * A mapping of tags to assign to the file system.
     */
    tags?: pulumi.Input<aws.Tags>;
    /**
     * Throughput mode for the file system. Defaults to `bursting`. Valid values: `bursting`,
     * `provisioned`. When using `provisioned`, also set `provisioned_throughput_in_mibps`.
     */
    throughputMode?: pulumi.Input<string>;

    // Changes we made to the core args type.

    /**
     * Cluster this file system is intended to be used with.  Configuration values needed
     * by this file system will be pulled from this unless overridden below.
     */
    cluster: mod.Cluster;

    /**
     * The security group to use for the file system.  If not provided, a default one that allows
     * ingress for the cluster's VPC from port 2049 will be created.
     */
    securityGroup?: aws.ec2.SecurityGroup;

    /**
     * The subnets to mount the file system against.  If not provided, file system will be mounted
     * for every subnet in the cluster's network.
     */
    subnetIds?: pulumi.Input<string>[];

    /**
     * Path to mount file system at when a cluster is connected to an autoscaling group.  If not
     * provided, the default mountPath will be "/mnt/efs"
     */
    mountPath?: pulumi.Input<string>;
}

// Make sure our exported args shape is compatible with the overwrite shape we're trying to provide.
let overwriteShape: OverwriteShape = undefined!;
let argsShape: ClusterFileSystemArgs = undefined!;
argsShape = overwriteShape;
overwriteShape = argsShape;
