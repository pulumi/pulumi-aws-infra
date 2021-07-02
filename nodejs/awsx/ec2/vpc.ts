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
import * as topology from "./vpcTopology";

import * as utils from "../utils";

// Mapping from provider to Vpc.  'undefined' is used to encode the Vpc we create when no provider
// is passed in.
const providerToDefaultVpc = new Map<pulumi.ProviderResource | undefined, Vpc>();

class VpcData {
    // Convenience properties.  Equivalent to getting the IDs from teh corresponding XxxSubnets
    // properties.
    /** @internal */
    public readonly publicSubnetIds: pulumi.Output<string>[] = [];
    /** @internal */
    public readonly privateSubnetIds: pulumi.Output<string>[] = [];
    /** @internal */
    public readonly isolatedSubnetIds: pulumi.Output<string>[] = [];

    /** @internal */
    public readonly vpc: aws.ec2.Vpc;
    /** @internal */
    public readonly id: pulumi.Output<string>;

    /** @internal */
    public readonly publicSubnets: x.ec2.Subnet[] = [];
    /** @internal */
    public readonly privateSubnets: x.ec2.Subnet[] = [];
    /** @internal */
    public readonly isolatedSubnets: x.ec2.Subnet[] = [];

    /**
     * @internal
     * The internet gateway created to allow traffic to/from the internet to the public subnets.
     * Only available if this was created using [VpcArgs].
     */
    public internetGateway?: x.ec2.InternetGateway;

    /**
     * @internal
     * The nat gateways created to allow private subnets access to the internet.
     * Only available if this was created using [VpcArgs].
     */
    public readonly natGateways: x.ec2.NatGateway[] = [];

    /** @internal */
    private readonly parent: Vpc;

    /** @internal */
    constructor(name: string, parent: Vpc,
                args: InternalVpcArgs | ExistingVpcArgs | ExistingVpcIdArgs,
                opts: pulumi.ComponentResourceOptions) {
        this.parent = parent;

        if (isExistingVpcArgs(args)) {
            this.vpc = args.vpc;
            this.id = this.vpc.id;
        }
        else if (isExistingVpcIdArgs(args)) {
            this.vpc = aws.ec2.Vpc.get(name, args.vpcId, {}, opts),
            this.id = this.vpc.id;

            getExistingSubnets(this, this.parent, name, "public", args.publicSubnetIds);
            getExistingSubnets(this, this.parent, name, "private", args.privateSubnetIds);
            getExistingSubnets(this, this.parent, name, "isolated", args.isolatedSubnetIds);

            // Pass along aliases so that the previously unparented resources are now properly parented
            // to the vpc.
            if (args.internetGatewayId) {
                const igName = `${name}-ig`;
                this.internetGateway = new x.ec2.InternetGateway(igName, parent, {
                    internetGateway: aws.ec2.InternetGateway.get(igName, args.internetGatewayId, {}, { parent }),
                }, { parent, aliases: [{ parent: pulumi.rootStackResource }] });
            }

            if (args.natGatewayIds) {
                for (let i = 0, n = args.natGatewayIds.length; i < n; i++) {
                    const natGatewayId = args.natGatewayIds[i];
                    const natName = `${name}-nat-${i}`;
                    this.natGateways.push(new x.ec2.NatGateway(natName, parent, {
                        natGateway: aws.ec2.NatGateway.get(natName, natGatewayId, {}, { parent }),
                    }, { parent, aliases: [{ parent: pulumi.rootStackResource }] }));
                }
            }
        }
        else {
            const cidrBlock = args.cidrBlock === undefined ? "10.0.0.0/16" : args.cidrBlock;
            const availabilityZones = args.availabilityZones;

            const numberOfNatGateways = args.numberOfNatGateways === undefined ? availabilityZones.length : args.numberOfNatGateways;
            const assignGeneratedIpv6CidrBlock = utils.ifUndefined(args.assignGeneratedIpv6CidrBlock, false);

            // We previously did not parent the underlying Vpc to this component. We now do. Provide
            // an alias so this doesn't cause resources to be destroyed/recreated for existing
            // stacks.
            this.vpc = new aws.ec2.Vpc(name, {
                ...args,
                cidrBlock,
                enableDnsHostnames: utils.ifUndefined(args.enableDnsHostnames, true),
                enableDnsSupport: utils.ifUndefined(args.enableDnsSupport, true),
                instanceTenancy: utils.ifUndefined(args.instanceTenancy, "default"),
                assignGeneratedIpv6CidrBlock,
            }, { parent, aliases: [{ parent: pulumi.rootStackResource }] });
            this.id = this.vpc.id;

            const subnets = args.subnets || [
                { type: "public" },
                { type: "private" },
            ];

            this.partition(
                name, cidrBlock, availabilityZones, numberOfNatGateways,
                assignGeneratedIpv6CidrBlock, subnets, opts);

            // Create an internet gateway if we have public subnets.
            this.addInternetGateway(name, this.publicSubnets);
        }
    }

    /** @internal */
    public partition(
            name: string, cidrBlock: CidrBlock, availabilityZones: topology.AvailabilityZoneDescription[],
            numberOfNatGateways: number, assignGeneratedIpv6CidrBlock: pulumi.Output<boolean>,
            subnetArgs: VpcSubnetArgs[], opts: pulumi.ComponentResourceOptions) {
        // Create the appropriate subnets.  Default to a single public and private subnet for each
        // availability zone if none were specified.
        const { subnets, natGateways, natRoutes } = topology.create(
            this.parent, name, cidrBlock, this.vpc.ipv6CidrBlock, availabilityZones,
            numberOfNatGateways, assignGeneratedIpv6CidrBlock, subnetArgs);

        for (const desc of subnets) {
            // We previously did not parent the subnet to this component. We now do. Provide an
            // alias so this doesn't cause resources to be destroyed/recreated for existing
            // stacks.
            // Only set one of availabilityZone or availabilityZoneId
            const availabilityZone = desc.args.availabilityZone;
            const availabilityZoneId = availabilityZone ? undefined : desc.args.availabilityZoneId;

            const subnet = new x.ec2.Subnet(desc.subnetName, this.parent, {
                ...desc.args,
                availabilityZone,
                availabilityZoneId,
                tags: utils.mergeTags({ type: desc.type, Name: desc.subnetName }, desc.args.tags),
            }, { aliases: [{ parent: opts.parent }], ignoreChanges: desc.ignoreChanges, parent: this.parent });

            this.addSubnet(desc.type, subnet);
        }

        for (const desc of natGateways) {
            const publicSubnet = this.publicSubnets.find(s => s.subnetName === desc.publicSubnet);
            if (!publicSubnet) {
                throw new pulumi.ResourceError(`Could not find public subnet named ${desc.publicSubnet}`, this.parent);
            }

            this.addNatGateway(desc.name, { subnet: publicSubnet });
        }

        for (const desc of natRoutes) {
            const privateSubnet = this.privateSubnets.find(s => s.subnetName === desc.privateSubnet);
            if (!privateSubnet) {
                throw new pulumi.ResourceError(`Could not find private subnet named ${desc.privateSubnet}`, this.parent);
            }

            const natGateway = this.natGateways.find(g => g.natGatewayName === desc.natGateway);
            if (!natGateway) {
                throw new pulumi.ResourceError(`Could not find nat gateway named ${desc.natGateway}`, this.parent);
            }

            privateSubnet.createRoute(desc.name, natGateway);
        }
    }

    /** @internal */
    private addSubnet(type: VpcSubnetType, subnet: x.ec2.Subnet) {
        this.getSubnets(type).push(subnet);
        this.getSubnetIds(type).push(subnet.id);
    }

    /** @internal */
    public getSubnets(type: VpcSubnetType) {
        switch (type) {
            case "public": return this.publicSubnets;
            case "private": return this.privateSubnets;
            case "isolated": return this.isolatedSubnets;
            default: throw new Error("Unexpected subnet type: " + type);
        }
    }

    /** @internal */
    public getSubnetIds(type: VpcSubnetType) {
        switch (type) {
            case "public": return this.publicSubnetIds;
            case "private": return this.privateSubnetIds;
            case "isolated": return this.isolatedSubnetIds;
            default: throw new Error("Unexpected subnet type: " + type);
        }
    }

    /**
     * @internal
     * Adds an [awsx.ec2.InternetGateway] to this VPC.  Will fail if this Vpc already has an
     * InternetGateway.
     *
     * @param subnets The subnets to route the InternetGateway to.  Will default to the [public]
     *        subnets of this Vpc if not specified.
     */
    public addInternetGateway(name: string, subnets?: x.ec2.Subnet[],
                              args: aws.ec2.InternetGatewayArgs = {},
                              opts: pulumi.ComponentResourceOptions = {}) {

        if (this.internetGateway) {
            throw new Error("Cannot add InternetGateway to Vpc that already has one.");
        }

        // See https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html#Add_IGW_Attach_Gateway
        // for more details.
        this.internetGateway = new x.ec2.InternetGateway(name, this.parent, args, opts);

        subnets = subnets || this.publicSubnets;
        for (const subnet of subnets) {
            subnet.createRoute("ig", this.internetGateway);
        }

        return this.internetGateway;
    }

    /**
     * @internal
     * Adds an [awsx.ec2.NatGateway] to this VPC. The NatGateway must be supplied a subnet (normally
     * public) to be placed in.  After adding the NatGateway you should update the route table
     * associated with one or more of your private subnets to point Internet-bound traffic to the
     * NAT gateway. This enables instances in your private subnets to communicate with the internet.
     *
     * This can be done by calling [subnet.createRoute] and passing in the newly created NatGateway.
     */
    public addNatGateway(name: string, args: x.ec2.NatGatewayArgs, opts: pulumi.ComponentResourceOptions = {}) {
        const natGateway = new x.ec2.NatGateway(name, this.parent, args, opts);
        this.natGateways.push(natGateway);
        return natGateway;
    }
}

(<any>VpcData).doNotCapture = true;
utils.Capture(VpcData.prototype).addInternetGateway.doNotCapture = true;
utils.Capture(VpcData.prototype).addNatGateway.doNotCapture = true;
utils.Capture(VpcData.prototype).partition.doNotCapture = true;

export class Vpc extends pulumi.ComponentResource<VpcData> {
    public readonly id: pulumi.Output<string>;

    public readonly vpc: pulumi.Output<aws.ec2.Vpc>;

    constructor(name: string, args?: VpcArgs | ExistingVpcArgs | ExistingVpcIdArgs, opts?: pulumi.ComponentResourceOptions);
    /** @internal */
    constructor(name: string, args: DefaultVpcArgs, opts?: pulumi.ComponentResourceOptions);
    constructor(name: string, args: VpcArgs | ExistingVpcArgs | ExistingVpcIdArgs | DefaultVpcArgs = {}, opts: pulumi.ComponentResourceOptions = {}) {
        super("awsx:x:ec2:Vpc", name, { name, args, opts }, opts);

        const data = this.getData();

        this.id = pulumi.output(data.then(v => v.id));
        this.vpc = pulumi.output(data.then(d => d.vpc));
    }

    protected initialize(props: { name: string, args: any, opts: pulumi.ComponentResourceOptions }): Promise<VpcData> {
        const name = props.name;
        const args = props.args;
        const opts = props.opts;
        if (isExistingVpcArgs(args)) {
            return this.initializeExistingVpcArgs(name, args, opts);
        }
        else if (isDefaultVpcArgs(args)) {
            return this.initializeDefaultVpcArgs(name, args, opts);
        }
        else if (isExistingVpcIdArgs(args)) {
            return this.initializeExistingVpcIdArgs(name, args, opts);
        }
        else {
            return this.initializeVpcArgs(name, args, opts);
        }
    }

    /** @internal */
    public async initializeExistingVpcArgs(name: string, args: ExistingVpcArgs, opts: pulumi.ComponentResourceOptions): Promise<VpcData> {
        return new VpcData(name, this, args, opts);
    }

    /** @internal */
    public async initializeExistingVpcIdArgs(name: string, args: ExistingVpcIdArgs, opts: pulumi.ComponentResourceOptions): Promise<VpcData> {
        return new VpcData(name, this, args, opts);
    }

    /** @internal */
    public async initializeDefaultVpcArgs(name: string, args: DefaultVpcArgs, opts: pulumi.ComponentResourceOptions): Promise<VpcData> {
        // back compat.  We always would just use the first two public subnets of the region
        // we're in.  So preserve that, even though we could get all of them here.  Pulling in
        // more than the two we pulled in before could have deep implications for clients as
        // those subnets are used to make many downstream resource-creating decisions.
        const vpcId = await args.vpcId;
        const provider = args.provider;
        const getSubnetsResult = await aws.ec2.getSubnetIds({ vpcId  }, { provider, async: true });
        const publicSubnetIds = getSubnetsResult.ids.slice(0, 2);

        return new VpcData(name, this, {
            vpcId,
            publicSubnetIds,
        }, opts);
    }

    /** @internal */
    public async initializeVpcArgs(name: string, args: x.ec2.VpcArgs, opts: pulumi.ComponentResourceOptions): Promise<VpcData> {
        const provider = Vpc.getProvider(opts);
        const availabilityZones = await getAvailabilityZones(opts.parent, provider, args.numberOfAvailabilityZones);

        return new VpcData(name, this, {
            ...args,
            availabilityZones,
        }, opts);
    }

    private static getProvider(opts: pulumi.InvokeOptions = {}) {
        // Pull out the provider to ensure we're looking up the default vpc in the right location.
        // Note that we do not pass 'parent' along as we want the default vpc to always be parented
        // logically by hte stack.
        const provider = opts.provider ? opts.provider :
                         opts.parent   ? opts.parent.getProvider("aws::") : undefined;
        return provider;
    }

    public async addInternetGateway(
        name: string, subnets?: x.ec2.Subnet[],
        args: aws.ec2.InternetGatewayArgs = {}, opts: pulumi.ComponentResourceOptions = {}) {

        const vpc = await this.getData();
        vpc.addInternetGateway(name, subnets, args, opts);
    }

    public async addNatGateway(name: string, args: x.ec2.NatGatewayArgs, opts: pulumi.ComponentResourceOptions = {}) {
        const vpc = await this.getData();
        vpc.addNatGateway(name, args, opts);
    }

    /**
     * Get an existing Vpc resource's state with the given name and IDs of its relevant
     * sub-resources. This will not cause a VPC (or any sub-resources) to be created, and removing
     * this Vpc from your pulumi application will not cause the existing cloud resource (or
     * sub-resources) to be destroyed.
     */
    public static fromExistingIds(name: string, idArgs: ExistingVpcIdArgs, opts?: pulumi.ComponentResourceOptions) {
        return new Vpc(name, idArgs, opts);
    }

    /**
     * Gets the default vpc for the current aws account and region.
     *
     * See https://docs.aws.amazon.com/vpc/latest/userguide/default-vpc.html for more details.
     *
     * Note: the no-arg version of this call is not recommended.  It will acquire the default Vpc
     * for the current region and cache it.  Instead, it is recommended that the `getDefault(opts)`
     * version be used instead with either `opts.provider` or `opts.parent` set.  This version will
     * properly get the default vpc for the region the provider specifies.
     *
     * This method will return the same Vpc instance when passed the same `provider`.
     */
    public static getDefault(opts: pulumi.InvokeOptions = {}): Vpc {
        // Pull out the provider to ensure we're looking up the default vpc in the right location.
        // Note that we do not pass 'parent' along as we want the default vpc to always be parented
        // logically by hte stack.
        const provider = Vpc.getProvider(opts);

        let vpc = providerToDefaultVpc.get(provider);
        if (!vpc) {
            const vpcName = "default-" + (provider ? (<any>provider).__name : "vpc");

            // For back compat with how we previously named things, also create an alias from
            // "default-vpc" to this name for the very first default Vpc we create as that's how we
            // used to name them.
            const aliases: pulumi.Alias[] = providerToDefaultVpc.size === 0
                ? [{ name: "default-vpc" }]
                : [];

            // Also add an alias to "default-vpc-id".  This is the name we generated for
            // default-vpcs when we had sync data-sources.
            const vpcId = aws.ec2.getVpc({ default: true }, { provider, async: true }).then(r => r.id);
            aliases.push({ name: vpcId.then(vpcId => "default-" + vpcId) });

            vpc = new Vpc(vpcName, {
                isDefault: true,
                vpcId,
                provider,
            }, { provider, aliases });
            providerToDefaultVpc.set(provider, vpc);
        }

        return vpc;
    }

    // lifted members of VpcData

    /** @internal */
    private async liftMember<T>(func: (d: VpcData) => T, def: T): Promise<T> {
        const data = await this.getData();
        if (!data) {
            return def;
        }
        return func(data);
    }

    /**
     * Asynchronously retrieves the IDs for the public subnets in this Vpc.  This will only retrieve
     * data for the subnets specified when the Vpc was created.  If subnets were created externally,
     * they will not be included.
     */
    public get publicSubnetIds() { return this.liftMember(v => v.publicSubnetIds, []); }

    /**
     * Asynchronously retrieves the IDs for the private subnets in this Vpc.  This will only retrieve
     * data for the subnets specified when the Vpc was created.  If subnets were created externally,
     * they will not be included.
     */
    public get privateSubnetIds() { return this.liftMember(v => v.privateSubnetIds, []); }

    /**
     * Asynchronously retrieves the IDs for the isolated subnets in this Vpc.  This will only retrieve
     * data for the subnets specified when the Vpc was created.  If subnets were created externally,
     * they will not be included.
     */
    public get isolatedSubnetIds() { return this.liftMember(v => v.isolatedSubnetIds, []); }

    /**
     * Asynchronously retrieves the IDs for the subnets of a particular type in this Vpc.  This will
     * only retrieve data for the subnets specified when the Vpc was created.  If subnets were
     * created externally, they will not be included.
     */
    public getSubnetsIds(type: VpcSubnetType) { return this.liftMember(d => d.getSubnetIds(type), []); }

    /**
     * Asynchronously retrieves the public subnets in this Vpc.  This will only retrieve data for
     * the subnets specified when the Vpc was created.  If subnets were created externally, they
     * will not be included.
     */
    public get publicSubnets() { return this.liftMember(v => v.publicSubnets, []); }

    /**
     * Asynchronously retrieves the private subnets in this Vpc.  This will only retrieve data for
     * the subnets specified when the Vpc was created.  If subnets were created externally, they
     * will not be included.
     */
    public get privateSubnets() { return this.liftMember(v => v.privateSubnets, []); }

    /**
     * Asynchronously retrieves the isolated subnets in this Vpc.  This will only retrieve data for
     * the subnets specified when the Vpc was created.  If subnets were created externally, they
     * will not be included.
     */
    public get isolatedSubnets() { return this.liftMember(v => v.isolatedSubnets, []); }

    /**
     * Asynchronously retrieves the subnets of a particular type in this Vpc.  This will only
     * retrieve data for the subnets specified when the Vpc was created.  If subnets were created
     * externally, they will not be included.
     */
    public getSubnets(type: VpcSubnetType) { return this.liftMember(d => d.getSubnets(type), []); }

    /**
     * The internet gateway created to allow traffic to/from the internet to the public subnets.
     * Only available if this was created using [VpcArgs].
     */
    public get internetGateway() { return this.liftMember(v => v.internetGateway, undefined); }

    /**
     * The nat gateways created to allow private subnets access to the internet.
     * Only available if this was created using [VpcArgs].
     */
    public get natGateways() { return this.liftMember(v => v.natGateways, []); }

    // end lifting
}

utils.Capture(Vpc.prototype).addInternetGateway.doNotCapture = true;
utils.Capture(Vpc.prototype).addNatGateway.doNotCapture = true;
utils.Capture(Vpc.prototype).initializeDefaultVpcArgs.doNotCapture = true;
utils.Capture(Vpc.prototype).initializeExistingVpcArgs.doNotCapture = true;
utils.Capture(Vpc.prototype).initializeExistingVpcIdArgs.doNotCapture = true;
utils.Capture(Vpc.prototype).initializeVpcArgs.doNotCapture = true;

async function getAvailabilityZones(
        parent: pulumi.Resource | undefined,
        provider: pulumi.ProviderResource | undefined,
        requestedCount: "all" | number | undefined): Promise<topology.AvailabilityZoneDescription[]> {

    const result = await aws.getAvailabilityZones(/*args:*/ undefined, { provider, async: true });
    if (result.names.length !== result.zoneIds.length) {
        throw new pulumi.ResourceError("Availability zones for region had mismatched names and ids.", parent);
    }

    const descriptions: topology.AvailabilityZoneDescription[] = [];
    for (let i = 0, n = result.names.length; i < n; i++) {
        descriptions.push({ name: result.names[i], id: result.zoneIds[i] });
    }

    const count =
        typeof requestedCount === "number" ? requestedCount :
        requestedCount === "all" ? descriptions.length : 2;

    return descriptions.slice(0, count);
}

function getExistingSubnets(vpcData: VpcData, vpc: Vpc, vpcName: string, type: VpcSubnetType, inputs: pulumi.Input<string>[] = []) {
    const subnets = vpcData.getSubnets(type);
    const subnetIds = vpcData.getSubnetIds(type);

    for (let i = 0, n = inputs.length; i < n; i++) {
        const subnetName = `${vpcName}-${type}-${i}`;
        const subnet = new x.ec2.Subnet(subnetName, vpc, {
            subnet: aws.ec2.Subnet.get(subnetName, inputs[i], /*state:*/undefined, { parent: vpc }),
        }, { parent: vpc });

        subnets.push(subnet);
        subnetIds.push(subnet.id);
    }
}

getExistingSubnets.doNotCapture = true;

/**
 * The type of this subnet.
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
 * Information that controls how each vpc subnet should be created for each availability zone. By
 * default, the Vpc will control actually creating the appropriate subnets in each zone depending on
 * the values specified in this type.  This help ensure that each subnet will reside entirely within
 * one Availability Zone and cannot span zones.
 *
 * For finer control of the locations of the subnets, specify the [location] property for all the
 * subnets.
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
     *
     * If this property is provided, [location] cannot be provided.
     */
    cidrMask?: number;

    /**
     * More precise information about the location of this subnet.  Can either be a simple CidrBlock
     * (i.e. 10.0.0.0/24), or a richer object describing the CidrBlocks and Availability Zone for
     * the subnet.
     *
     * If this property is provided, [cidrMask] cannot be provided.
     *
     * If only a CidrBlock is provided here, then the subnet will be placed in the first
     * availability zone for the region.
     *
     * If this property is provided for one subnet, it must be provided for all subnets.
     */
    location?: CidrBlock | VpcSubnetLocation;

    /**
     * Specify true to indicate that network interfaces created in the specified subnet should be
     * assigned an IPv6 address. Defaults to the value of VpcArgs.assignGeneratedIpv6CidrBlock.
     */
    assignIpv6AddressOnCreation?: pulumi.Input<boolean>;

    /**
     * Specify true to indicate that instances launched into the subnet should be assigned a public
     * IP address. Default's to `true` if `type` is `public`.  `false` otherwise.
     */
    mapPublicIpOnLaunch?: pulumi.Input<boolean>;

    tags?: pulumi.Input<aws.Tags>;

    /**
     * Ignore changes to any of the specified properties of the Subnet.
     */
    ignoreChanges?: string[];
}

/**
 * Alias for a cidr block.
 */
export type CidrBlock = string;

export interface VpcSubnetLocation {
    /**
     * The AZ for the subnet.
     */
    availabilityZone?: string;
    /**
     * The AZ ID of the subnet.
     */
    availabilityZoneId?: string;
    /**
     * The CIDR block for the subnet.
     */
    cidrBlock: pulumi.Input<CidrBlock>;
    /**
     * The IPv6 network range for the subnet, in CIDR notation. The subnet size must use a /64
     * prefix length.
     */
    ipv6CidrBlock?: pulumi.Input<string>;
}

export interface ExistingVpcIdArgs {
    /** The id of the VPC. */
    vpcId: pulumi.Input<string>;
    /** The public subnets for the vpc. */
    publicSubnetIds?: pulumi.Input<string>[];
    /** The private subnets for the vpc. */
    privateSubnetIds?: pulumi.Input<string>[];
    /** The isolated subnets for the vpc. */
    isolatedSubnetIds?: pulumi.Input<string>[];
    /** The id of the internet gateway for this VPC */
    internetGatewayId?: pulumi.Input<string>;
    /** The ids of the nat gateways for this VPC */
    natGatewayIds?: pulumi.Input<string>[];
}

function isExistingVpcIdArgs(obj: any): obj is ExistingVpcIdArgs {
    return !!(<ExistingVpcIdArgs>obj).vpcId;
}

interface DefaultVpcArgs {
    /** The id of the VPC. */
    vpcId: Promise<string>;
    provider: pulumi.ProviderResource | undefined;
    isDefault: true;
}

function isDefaultVpcArgs(obj: any): obj is DefaultVpcArgs {
    return (<DefaultVpcArgs>obj).isDefault === true;
}

export interface ExistingVpcArgs {
    /** The id of the VPC. */
    vpc: aws.ec2.Vpc;
}

function isExistingVpcArgs(obj: any): obj is ExistingVpcArgs {
    return !!(<ExistingVpcArgs>obj).vpc;
}

type OverwriteShape = utils.Overwrite<aws.ec2.VpcArgs, {
    cidrBlock?: CidrBlock;
    instanceTenancy?: pulumi.Input<"default" | "dedicated">;
}>;

export interface VpcArgs {
    /**
     * The information about what subnets to create per availability zone.  Defaults to one public and
     * one private subnet if unspecified.
     */
    subnets?: VpcSubnetArgs[];

    /**
     * The maximum number of availability zones to use in the current region.  Defaults to `2` if
     * unspecified.  Use `"all"` to use all the availability zones in the current region.
     */
    numberOfAvailabilityZones?: number | "all";

    /**
     * The max number of NAT gateways to create if there are any private subnets created.  A NAT
     * gateway enables instances in a private subnet to connect to the internet or other AWS
     * services, but prevent the internet from initiating a connection with those instances. A
     * minimum of '1' gateway is needed if an instance is to be allowed connection to the internet.
     *
     * If this is not set, a nat gateway will be made for each availability zone in the current
     * region. The first public subnet for that availability zone will be the one used to place the
     * nat gateway in.  If less gateways are requested than availability zones, then only that many
     * nat gateways will be created.
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
     * Requests an Amazon-provided IPv6 CIDR block with a /56 prefix length for the VPC. You cannot
     * specify the range of IP addresses, or the size of the CIDR block. Default is `false`.  If set
     * to `true`, then subnets created will default to `assignIpv6AddressOnCreation: true` as well.
     */
    assignGeneratedIpv6CidrBlock?: pulumi.Input<boolean>;

    /**
     * The CIDR block for the VPC.  Defaults to "10.0.0.0/16" if unspecified.
     */
    cidrBlock?: CidrBlock;
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

interface InternalVpcArgs extends VpcArgs {
    availabilityZones: topology.AvailabilityZoneDescription[];
}

// Make sure our exported args shape is compatible with the overwrite shape we're trying to provide.
const test1: string = utils.checkCompat<OverwriteShape, VpcArgs>();
