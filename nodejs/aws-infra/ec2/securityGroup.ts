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

import * as x from "..";
import * as utils from "./../utils";

export class SecurityGroup extends pulumi.ComponentResource {
    public readonly securityGroup: aws.ec2.SecurityGroup;
    public readonly id: pulumi.Output<string>;
    public readonly vpc: x.ec2.Vpc;

    public readonly egressRules: x.ec2.IngressSecurityGroupRule[] = [];
    public readonly ingressRules: x.ec2.IngressSecurityGroupRule[] = [];

    // tslint:disable-next-line:variable-name
    private readonly __isSecurityGroupInstance = true;

    constructor(name: string, args: SecurityGroupArgs = {}, opts: pulumi.ComponentResourceOptions = {}) {
        super("awsinfra:x:ec2:SecurityGroup", name, {}, opts);

        this.vpc = args.vpc || x.ec2.Vpc.getDefault();
        this.securityGroup = args.securityGroup || new aws.ec2.SecurityGroup(name, {
            ...args,
            vpcId: this.vpc.id,
        }, { parent: this });
        this.id = this.securityGroup.id;

        this.registerOutputs();
    }

    /** @internal */
    public static isSecurityGroupInstance(obj: any): obj is SecurityGroup {
        return !!(<SecurityGroup>obj).__isSecurityGroupInstance;
    }

    public static fromExistingId(
        name: string, id: pulumi.Input<string>,
        args: SecurityGroupArgs = {}, opts: pulumi.ComponentResourceOptions = {}) {

        return new SecurityGroup(name, {
            ...args,
            securityGroup: aws.ec2.SecurityGroup.get(name, id, {}, opts),
        }, opts);
    }

    public createEgressRule(
            name: string, args: x.ec2.EgressSecurityGroupRuleArgs, opts?: pulumi.ComponentResourceOptions) {
        return new x.ec2.EgressSecurityGroupRule(name, this, args, opts);
    }

    public createIngressRule(
            name: string, args: x.ec2.IngressSecurityGroupRuleArgs, opts?: pulumi.ComponentResourceOptions) {
        return new x.ec2.IngressSecurityGroupRule(name, this, args, opts);
    }

    public openPorts(name: string,
                     location: x.ec2.SecurityGroupRuleLocation,
                     ports: x.ec2.SecurityGroupRulePorts,
                     description?: string,
                     opts?: pulumi.ComponentResourceOptions) {
        const egressArgs = x.ec2.SecurityGroupRule.egressArgs(location, ports, description);
        const ingressArgs = x.ec2.SecurityGroupRule.ingressArgs(location, ports, description);
        const egress = this.createEgressRule(name + "-egress", egressArgs, opts);
        const ingress = this.createIngressRule(name + "-ingress", ingressArgs, opts);

        return { egress, ingress };
    }
}

export type SecurityGroupOrId = SecurityGroup | pulumi.Input<string>;

/** @internal */
export function getSecurityGroups(
        vpc: x.ec2.Vpc, name: string, args: SecurityGroupOrId[] | undefined,
        opts: pulumi.ResourceOptions | undefined) {
    if (!args) {
        return undefined;
    }

    const result: x.ec2.SecurityGroup[] = [];
    for (let i = 0, n = args.length; i < n; i++) {
        const obj = args[i];
        if (x.ec2.SecurityGroup.isSecurityGroupInstance(obj)) {
            result.push(obj);
        }
        else {
            result.push(x.ec2.SecurityGroup.fromExistingId(`${name}-${i}`, obj, {
                vpc,
            }, opts));
        }
    }

    return result;
}

type OverwriteSecurityGroupArgs = utils.Overwrite<aws.ec2.SecurityGroupArgs, {
    name?: never;
    namePrefix?: never;
    vpcId?: never;

    vpc?: x.ec2.Vpc;
}>;

export interface SecurityGroupArgs {
    /**
     * An existing SecurityGroup to use for this awsinfra SecurityGroup.  If not provided, a default
     * one will be created.
     */
    securityGroup?: aws.ec2.SecurityGroup;

    /**
     * The vpc this security group applies to.  Or [Network.getDefault] if unspecified.
     */
    vpc?: x.ec2.Vpc;

    /**
     * The security group description. Defaults to "Managed by Terraform". Cannot be "". __NOTE__:
     * This field maps to the AWS `GroupDescription` attribute, for which there is no Update API. If
     * you'd like to classify your security groups in a way that can be updated, use `tags`.
     */
    description?: pulumi.Input<string>;

    /**
     * Can be specified multiple times for each egress rule. Each egress block supports fields
     * documented below.
     */
    egress?: aws.ec2.SecurityGroupArgs["egress"];

    /**
     * Can be specified multiple times for each ingress rule. Each ingress block supports fields
     * documented below.
     */
    ingress?: aws.ec2.SecurityGroupArgs["ingress"];

    /**
     * Instruct Terraform to revoke all of the Security Groups attached ingress and egress rules
     * before deleting the rule itself. This is normally not needed, however certain AWS services
     * such as Elastic Map Reduce may automatically add required rules to security groups used with
     * the service, and those rules may contain a cyclic dependency that prevent the security groups
     * from being destroyed without removing the dependency first. Default `false`
     */
    revokeRulesOnDelete?: pulumi.Input<boolean>;

    tags?: pulumi.Input<aws.Tags>;
}

// Make sure our exported args shape is compatible with the overwrite shape we're trying to provide.
const test1: string = utils.checkCompat<OverwriteSecurityGroupArgs, SecurityGroupArgs>();
