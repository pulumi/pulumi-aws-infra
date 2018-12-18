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
import { VpcTopology } from "./vpcTopology";

import * as utils from "./../../utils";

let defaultVpc: Vpc;

export class Vpc extends pulumi.ComponentResource {
    /**
     * Id for the underlying [aws.ec2.Vpc] instance.
     */
    public readonly vpcId: pulumi.Output<string>;
    public readonly publicSubnetIds: pulumi.Output<string>[] = [];
    public readonly privateSubnetIds: pulumi.Output<string>[] = [];
    public readonly isolatedSubnetIds: pulumi.Output<string>[] = [];
    public readonly securityGroupIds: pulumi.Output<string>[] = [];

    public readonly instance: () => aws.ec2.Vpc;
    public readonly securityGroups: () => x.ec2.SecurityGroup[];

    /**
     * Only available if this was created using [VpcArgs].
     */
    public readonly publicSubnets: x.ec2.Subnet[] = [];
    public readonly privateSubnets: x.ec2.Subnet[] = [];
    public readonly isolatedSubnets: x.ec2.Subnet[] = [];

    /**
     * The internet gateway created to allow traffic to/from the internet to the public subnets.
     */
    public readonly internetGateway: aws.ec2.InternetGateway;

    /**
     * The nat gateways created to allow private subnets access to the internet.
     */
    public readonly natGateways: aws.ec2.NatGateway[] = [];

    constructor(name: string, args: VpcArgs, opts?: pulumi.ComponentResourceOptions);
    constructor(name: string, args: ExistingVpcArgs, opts?: pulumi.ComponentResourceOptions);
    constructor(name: string, args: VpcArgs | ExistingVpcArgs, opts?: pulumi.ComponentResourceOptions) {
        super("awsinfra:x:ec2:Vpc", name, {}, opts);

        if (isExistingVpcArgs(args)) {
            this.vpcId = pulumi.output(args.vpcId);
            this.publicSubnetIds = createOutputs(args.publicSubnetIds);
            this.privateSubnetIds = createOutputs(args.privateSubnetIds);
            this.isolatedSubnetIds = createOutputs(args.isolatedSubnetIds);

            let instance: aws.ec2.Vpc;
            this.instance = () => {
                if (!instance) {
                    instance = aws.ec2.Vpc.get(name, this.vpcId);
                }

                return instance;
            };

            return;
        }

        const cidrBlock = args.cidrBlock === undefined ? "10.0.0.0/16" : args.cidrBlock;
        const numberOfAvailabilityZones = args.numberOfAvailabilityZones === undefined ? 2 : args.numberOfAvailabilityZones;
        const numberOfNatGateways = args.numberOfNatGateways === undefined ? numberOfAvailabilityZones : args.numberOfNatGateways;
        if (numberOfNatGateways > numberOfAvailabilityZones) {
            throw new Error(`[numberOfNatGateways] cannot be greater than [numberOfAvailabilityZones]: ${numberOfNatGateways} > ${numberOfAvailabilityZones}`);
        }

        const instance = new aws.ec2.Vpc(name, {
            ...args,
            cidrBlock,
            enableDnsHostnames: utils.ifUndefined(args.enableDnsHostnames, true),
            enableDnsSupport: utils.ifUndefined(args.enableDnsSupport, true),
            instanceTenancy: utils.ifUndefined(args.instanceTenancy, "default"),
        });

        this.instance = () => instance;
        this.vpcId =  instance.id;

        // Create the appropriate subnets.  Default to a single public and private subnet for each
        // availability zone if none were specified.
        const topology = new VpcTopology(this, name, cidrBlock, numberOfAvailabilityZones, opts);
        topology.createSubnets(args.subnets || [
            { type: "public" },
            { type: "private"},
        ]);

        // Create an internet gateway if we have public subnets.
        this.internetGateway = this.createInternetGateway(name)!;

        // Create nat gateways if we have private subnets.
        this.createNatGateways(numberOfAvailabilityZones, numberOfNatGateways);

        this.registerOutputs();
    }

    private createInternetGateway(name: string) {
        if (this.publicSubnets.length === 0) {
            return undefined;
        }

        // See https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html#Add_IGW_Attach_Gateway
        // for more details.
        const internetGateway = new aws.ec2.InternetGateway(name, {
            vpcId: this.vpcId,
        });

        // Hook up all public subnets through that internet gateway.
        for (const publicSubnet of this.publicSubnets) {
            publicSubnet.routes.push(new aws.ec2.Route(`${publicSubnet.subnetName}-ig`, {
                // From above: For IPv4 traffic, specify 0.0.0.0/0 in the Destination box, and
                // select the internet gateway ID in the Target list.
                destinationCidrBlock: "0.0.0.0/0",
                routeTableId: publicSubnet.routeTable.id,
                gatewayId: internetGateway.id,
            }, { parent: publicSubnet }));
        }

        return internetGateway;
    }

    private createNatGateways(numberOfAvailabilityZones: number, numberOfNatGateways: number) {
        // Create nat gateways if we have private subnets and we have public subnets to place them in.
        if (this.privateSubnets.length === 0 || numberOfNatGateways === 0 || this.publicSubnets.length === 0) {
            return;
        }

        for (let i = 0; i < numberOfNatGateways; i++) {
            // Each public subnet was already created across all availability zones.  So, to
            // maximize coverage of availability zones, we can just walk the public subnets and
            // create a nat gateway for it's availability zone.  If more natgateways were
            // requested then we'll just round-robin them among the availability zones.
            const availabilityZone = i % numberOfAvailabilityZones;

            // this indexing is safe since we would have created the any subnet across all
            // availability zones.
            const publicSubnet = this.publicSubnets[availabilityZone];
            const parentOpts = { parent: publicSubnet };

            // from https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html
            //
            // you must also specify an Elastic IP address to associate with the NAT gateway
            // when you create it. After you've created a NAT gateway, you must update the route
            // table associated with one or more of your private subnets to point Internet-bound
            // traffic to the NAT gateway. This enables instances in your private subnets to
            // communicate with the internet.
            const natName = `nat-${i}`;
            const elasticIP = new aws.ec2.Eip(natName, {
                tags: { Name: natName },
            }, parentOpts);

            const natGateway = new aws.ec2.NatGateway(natName, {
                subnetId: publicSubnet.subnetId,
                allocationId: elasticIP.id,
            }, parentOpts);

            this.natGateways.push(natGateway);
        }

        let roundRobinIndex = 0;

        // We created subnets 'numberOfAvailabilityZones' at a time.  So just jump through them in
        // chunks of that size.
        for (let i = 0, n = this.privateSubnets.length; i < n; i += numberOfAvailabilityZones) {
            // For each chunk of subnets, we will have spread them across all the availability
            // zones.  We also created a nat gateway per availability zone *up to*
            // numberOfNatGateways.  So for the subnets in an availability zone that we created a
            // nat gateway in, just route to that nat gateway.  For the other subnets that are
            // in an availability zone without a nat gateway, we just round-robin between any
            // nat gateway we created.
            for (let j = 0; j < numberOfAvailabilityZones; j++) {
                const privateSubnet = this.privateSubnets[i + j];
                const natGateway = j < numberOfNatGateways
                    ? this.natGateways[j]
                    : this.natGateways[roundRobinIndex++];

                privateSubnet.routes.push(new aws.ec2.Route(`${privateSubnet.subnetName}-nat-${j}`, {
                    // From above: For IPv4 traffic, specify 0.0.0.0/0 in the Destination box, and
                    // select the internet gateway ID in the Target list.
                    destinationCidrBlock: "0.0.0.0/0",
                    routeTableId: privateSubnet.routeTable.id,
                    natGatewayId: natGateway.id,
                }, { parent: privateSubnet }));
            }
        }
    }

    /**
     * Gets the default vpc for the current aws account and region.
     *
     * See https://docs.aws.amazon.com/vpc/latest/userguide/default-vpc.html for more details.
     */
    public static getDefault(opts?: pulumi.ComponentResourceOptions): Vpc {
        if (!defaultVpc) {
            return defaultVpc;
        }

        const vpc = aws.ec2.getVpc({default: true});
        const vpcId = vpc.then(v => v.id);

        // The default VPC will contain at least two public subnets (one per availability zone).
        // See https://docs.aws.amazon.com/vpc/latest/userguide/images/default-vpc-diagram.png for
        // more information.
        const subnetIds = vpcId.then(id => aws.ec2.getSubnetIds({ vpcId: id }))
                               .then(subnets => subnets.ids);
        const subnet0 = subnetIds.then(ids => ids[0]);
        const subnet1 = subnetIds.then(ids => ids[1]);

        const defaultSecurityGroup = vpcId.then(id => aws.ec2.getSecurityGroup({ name: "default", vpcId: id }))
                                          .then(sg => sg.id);

        defaultVpc = new Vpc("default-vpc", {
            vpcId,
            publicSubnetIds: [subnet0, subnet1],
            securityGroupIds: [defaultSecurityGroup],
        }, opts);

        return defaultVpc;
    }

    /**
     * Creates a new [NetworkLoadBalancer] for this [Vpc].
     */
    public createNetworkLoadBalancer(
            name: string,
            args: x.elasticloadbalancingv2.NetworkLoadBalancerArgs = {},
            opts?: pulumi.ComponentResourceOptions) {
        return new x.elasticloadbalancingv2.NetworkLoadBalancer(name, {
                vpc: this,
                ...args,
            }, opts || { parent: this });
    }

    /**
     * Creates a new [NetworkLoadBalancer] and [NetworkListener] for this [Vpc].  The
     * NetworkListener will have a default [NetworkTargetGroup] created for it.
     */
    public createNetworkListener(name: string,
                                 listenerArgs: x.elasticloadbalancingv2.NetworkListenerArgs,
                                 loadBalancerArgs?: x.elasticloadbalancingv2.NetworkLoadBalancerArgs,
                                 opts?: pulumi.ComponentResourceOptions) {
        return this.createNetworkLoadBalancer(name, loadBalancerArgs, opts)
                   .createListener(name, listenerArgs, opts);
    }

    /**
     * Creates a new [NetworkLoadBalancer] and [NetworkTargetGroup] for this [Network].
     */
    public createNetworkTargetGroup(name: string,
                                    targetGroupArgs: x.elasticloadbalancingv2.NetworkTargetGroupArgs,
                                    loadBalancerArgs?: x.elasticloadbalancingv2.NetworkLoadBalancerArgs,
                                    opts?: pulumi.ComponentResourceOptions) {
        return this.createNetworkLoadBalancer(name, loadBalancerArgs, opts)
                   .createTargetGroup(name, targetGroupArgs, opts);
    }

    /**
     * Creates a new [ApplicationLoadBalancer] for this [Vpc].
     */
    public createApplicationLoadBalancer(
            name: string,
            args: x.elasticloadbalancingv2.ApplicationLoadBalancerArgs = {},
            opts?: pulumi.ComponentResourceOptions) {
        return new x.elasticloadbalancingv2.ApplicationLoadBalancer(name, {
                vpc: this,
                securityGroups: this.securityGroups(),
                ...args,
            }, opts || { parent: this });
    }

    /**
     * Creates a new [ApplicationLoadBalancer] and [ApplicationListener] for this [Network].  The
     * ApplicationListener will have a default [ApplicationTargetGroup] created for it.
     */
    public createApplicationListener(name: string,
                                     listenerArgs: x.elasticloadbalancingv2.ApplicationListenerArgs,
                                     loadBalancerArgs?: x.elasticloadbalancingv2.ApplicationLoadBalancerArgs,
                                     opts?: pulumi.ComponentResourceOptions) {
        return this.createApplicationLoadBalancer(name, loadBalancerArgs, opts)
                   .createListener(name, listenerArgs, opts);
    }

    /**
     * Creates a new [ApplicationLoadBalancer] and [ApplicationTargetGroup] for this [Network].
     */
    public createApplicationTargetGroup(name: string,
                                        targetGroupArgs: x.elasticloadbalancingv2.ApplicationTargetGroupArgs,
                                        loadBalancerArgs?: x.elasticloadbalancingv2.ApplicationLoadBalancerArgs,
                                        opts?: pulumi.ComponentResourceOptions) {
        return this.createApplicationLoadBalancer(name, loadBalancerArgs, opts)
                   .createTargetGroup(name, targetGroupArgs, opts);
    }
}

function initializeSecurityGroups(name: string, network: Network) {
    const result: x.ec2.SecurityGroup[] = [];
    for (let i = 0, n = network.securityGroupIds.length; i < n; i++) {
        const groupName = `${name}-${i}`;
        const securityGroup = aws.ec2.SecurityGroup.get(groupName, network.securityGroupIds[i]);
        result.push(new x.ec2.SecurityGroup(groupName, { network, instance: securityGroup }, { parent: network }));
    }

    return result;
}

function createOutputs(inputs: pulumi.Input<string>[] | undefined) {
    if (!inputs) {
        return [];
    }

    return inputs.map(i => pulumi.output(i));
}

/**
 * The type of this subet.
 *
 * 1. A "public" subnet will route traffic to an [InternetGateway].  If you specify a public subnet
 *    this InternetGateway will be created on your behalf and traffic will be routed accordingly.
 * 2. A "private" subnet is similar to "public" except that the subnet will not have a route to the
 *    [InternetGateway].  Instead, there will be a route entry setup for the NatGateway in that
 *    availability zone to the subnet.
 * 3. Unlike "public" or "private" subnets, an "isolated" subnet has no routing specified at all.
 */
export type VpcSubnetType = "public" | "private" | "isolated";

/**
 * Information that controls how each vpc subnet should be created for each availability zone. The
 * vpc will control actually creating the appropriate subnets in each zone depending on the values
 * specified in this type.  This help ensure that each subnet will reside entirely within one
 * Availability Zone and cannot span zones.
 *
 * See https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Subnets.html for more details.
 */
export interface VpcSubnetArgs {
    /**
     * The type of subnet to make in each availability zone.
     */
    type: VpcSubnetType;

    /**
     * An optional name to use as part of the subnet name.  If not provided, will be set to
     * "public"/"private"/"isolated" depending on the [type] of this subnet.  Required if making
     * multiple subnets with the same type.
     */
    name?: string;

    /**
     * The number of leading bits in the Vpc cidrBlock to use to define the cidrBlock for this
     * subnet. By providing masking bits, this can be computed in a way that ensures that each
     * subnet has a distinct block.
     *
     * If this is not provided, the cidrBlock for the vpc will be appropriately split based on the
     * number of subnets and availability zones there are.
     *
     * The allowed mask size is between a 28 netmask and 16 netmask.  See
     * https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Subnets.html for more details.
     */
    cidrMask?: number;

    tags?: pulumi.Input<aws.Tags>;
}

export interface ExistingVpcArgs {
    /** The id of the VPC. */
    vpcId: pulumi.Input<string>;
    /** The public subnets for the vpc. */
    publicSubnetIds?: pulumi.Input<string>[];
    /** The private subnets for the vpc. */
    privateSubnetIds?: pulumi.Input<string>[];
    /** The isolated subnets for the vpc. */
    isolatedSubnetIds?: pulumi.Input<string>[];
    /** The security group ids for the vpc. */
    securityGroupIds?: pulumi.Input<string>[];
}

function isExistingVpcArgs(obj: any): obj is ExistingVpcArgs {
    return !!(<ExistingVpcArgs>obj).vpcId;
}

type OverwriteShape = utils.Overwrite<aws.ec2.VpcArgs, {
    cidrBlock?: string;
}>;

export interface VpcArgs {
    /**
     * The information about what subnets to create per availability zone.  Defaults to one public and
     * one private subnet if unspecified.
     */
    subnets?: VpcSubnetArgs[];

    /**
     * The maximum number of availability zones to use in the current region.  Defaults to '2' if
     * unspecified.
     */
    numberOfAvailabilityZones?: number;

    /**
     * The number of NAT gateways to create if there are any private subnets created.  A NAT gateway
     * enables instances in a private subnet to connect to the internet or other AWS services, but
     * prevent the internet from initiating a connection with those instances. A minimum of '1'
     * gateway is needed if an instance is to be allowed connection to the internet.
     *
     * If this is set, a nat gateway will be made for each availability zone in the current region.
     * The first public subnet for that availability zone will be the one used to place the nat
     * gateway in.  If less gateways are requested than availability zones, then only
     * that many nat gateways will be created.
     *
     * Private subnets in an availability zone that contains a nat gateway will route through that
     * gateway.  Private subnets in an availability zone that does not contain a nat gateway will be
     * routed to the other nat gateways in a round-robin fashion.
     *
     * See https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html for more details.
     *
     * Defaults to [numberOfAvailabilityZones].
     */
    numberOfNatGateways?: number;
    /**
     * Requests an Amazon-provided IPv6 CIDR
     * block with a /56 prefix length for the VPC. You cannot specify the range of IP addresses, or
     * the size of the CIDR block. Default is `false`.
     */
    assignGeneratedIpv6CidrBlock?: pulumi.Input<boolean>;
    /**
     * The CIDR block for the VPC.  Defaults to "10.0.0.0/16" if unspecified.
     */
    cidrBlock?: string;
    /**
     * A boolean flag to enable/disable ClassicLink
     * for the VPC. Only valid in regions and accounts that support EC2 Classic.
     * See the [ClassicLink documentation][1] for more information. Defaults false.
     */
    enableClassiclink?: pulumi.Input<boolean>;
    /**
     * A boolean flag to enable/disable ClassicLink DNS Support for the VPC.
     * Only valid in regions and accounts that support EC2 Classic.
     */
    enableClassiclinkDnsSupport?: pulumi.Input<boolean>;
    /**
     * A boolean flag to enable/disable DNS hostnames in the VPC. Defaults to true if unspecified.
     */
    enableDnsHostnames?: pulumi.Input<boolean>;
    /**
     * A boolean flag to enable/disable DNS support in the VPC. Defaults true if unspecified.
     */
    enableDnsSupport?: pulumi.Input<boolean>;
    /**
     * A tenancy option for instances launched into the VPC.  Defaults to "default" if unspecified.
     */
    instanceTenancy?: pulumi.Input<"default" | "dedicated">;
    /**
     * A mapping of tags to assign to the resource.
     */
    tags?: pulumi.Input<aws.Tags>;
}

// Make sure our exported args shape is compatible with the overwrite shape we're trying to provide.
const test1: string = utils.checkCompat<OverwriteShape, VpcArgs>();
