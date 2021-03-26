
## Pulumi EC2 Components

Pulumi's API's for simplifying workin with [EC2](https://aws.amazon.com/ec2/).  The API currently primarily provides ways to define and configure a Virtual Private Cloud ([VPC](https://docs.aws.amazon.com/vpc/latest/userguide/what-is-amazon-vpc.html)), as well as customize the [Security Groups](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-network-security.html) around it.

### The Default VPC

By default, Amazon will create a 'Default VPC' in all regions of your account.  You can read more about this Default VPC [here](https://docs.aws.amazon.com/vpc/latest/userguide/default-vpc.html).  This VPC can be easily acquired in the following manner:

```ts
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const vpc = awsx.ec2.Vpc.getDefault();
```

Many components in awsx work with a specific VPC (for example, Clusters and LoadBalancers).  However, if a specific VPC is not provided, they will use this default VPC instead.  This makes it simple to set up infrastructure for the default VPC without having to explicitly provide it all the time.

### Custom VPCs

While using the default VPC can be very simple and convenient, it is not always desirable to do so, and it can often be advantageous to define your own VPCs with their own custom topology.  Doing this allows more fine grained control over many parts of the network structure including, but not limited to, controlling IP address configuration, as well as ingress/egress security filtering.

When you create a VPC, you must specify a range of IPv4 addresses for the VPC in the form of a Classless Inter-Domain Routing (CIDR) block.  If one is not specified then `10.0.0.0/16` will be used by default. This is the primary CIDR block for your VPC. For more information about CIDR notation, see [RFC 4632](https://tools.ietf.org/html/rfc4632).   For example:

```ts
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const vpc = new awsx.ec2.Vpc("custom", {
   cidrBlock: "10.0.0.0/16",
   // other args
   // ...
});
```

This range will then be partitioned accordingly into the VPC depending on the other arguments provided.  The additional arguments that affect this partitioning are `subnets` and `requestedAvailabilityZones`.

### Availability Zones

Availability Zones are distinct locations that are engineered to be isolated from failures in other Availability Zones. By launching instances in separate Availability Zones, you can protect your applications from the failure of a single location

Not providing a list of zones for `requestedAvailabilityZones` will default to `2`, but a different value can be specified like so if appropriate for your region:

```ts
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const vpc = new awsx.ec2.Vpc("custom", {
   cidrBlock: "10.0.0.0/16",
   requestedAvailabilityZones: 3,
});
```

Each availability zone will get an approximately equal share of the total CIDR address space for the VPC.

### Subnets

Subnets allow you partition each availability zone into regions with different levels of access.  A `public` subnet is one whose traffic is routed to an [Internet Gateway (IG)](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html).  A `private` subnet is one that is configured to use a [NAT Gateway(NAT)](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat.html) so that it can reach the internet, but which prevents the internet from initiating connections to it.  Finally, an `isolated` subnet is one that cannot reach the internet either through an IG or with NAT.

By default, if unspecified, a VPC will automatically partition each availability zone into a `public` subnet and a `private` subnet.  i.e. not providing a subnet configuration is equivalent to writing:

```ts
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const vpc = new awsx.ec2.Vpc("custom", {
   ...
   subnets: [{ type: "public" }, { type: "private" }],
});
```

To specify your own subnet configuration you can do the following:

```ts
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const vpc = new awsx.ec2.Vpc("custom", {
   cidrBlock: "10.0.0.0/16",
   requestedAvailabilityZones: 3,
   subnets: [{ type: "public" }, { type: "private" }, { type: isolated }],
});
```

There is no restriction on the number of public/private/isolated subnets in an availability zone.  For example, it might be useful to have multiple isolated subnets, one for DB instances and another for Redis instances.  To facilitate this sort of arrangement, subnets can be named for clarity.  i.e.:

```ts
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const vpc = new awsx.ec2.Vpc("custom", {
   cidrBlock: "10.0.0.0/16",
   requestedAvailabilityZones: 3,
   subnets: [
     { type: "public" },
     { type: "private" },
     { type: isolated, name: "db" },
     { type: isolated, name: "redis" }],
});
```

By default the subnets will divide the CIDR space for each availability zone equally.  If this is not desired, a particular size for each zone can be requested by passing in an appropriate netmask value between 16 and 28.  See [VPC and Subnet Sizing](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Subnets.html#VPC_Sizing) for more details.  This value can be provided for specific subnets you know the number of instances you want IP addresses for.  Whatever IP addresses are remaining in the availability zone will be split over the subnets that do not provide a defined size.

### Gateways

By default any VPC with `public` subnets will have an Internet Gateway created for it.  All `public` subnets will be routable for all IPv4 addresses connections.

To allow connections from `private` subnets to the internet, NAT gateways will be created.  If not specified, one NAT Gateway will be created for each availability zone.  Because the NAT gateway must be in a `public` subnet, then NAT gateways will only be created if there is at least one `public` subnet.  However, less NAT gateways can be requested (i.e. to save on [costs](https://aws.amazon.com/vpc/pricing/)).  To do that, provide the `numberOfNatGateways` property like so:

```ts
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const vpc = new awsx.ec2.Vpc("custom", {
   cidrBlock: "10.0.0.0/16",
   requestedAvailabilityZones: 3,
   numberOfNatGateways: 1,
});
```

In the case where there is one NAT gateway per availability zone, then routing is very simple.  Each `private` subnet will have have connections routed through gateway in that availability zone.  In the case where there are less NAT gateways than availability zones, then routing works slightly differently.  If there are N NAT gateways requested, then the first N availability zones will get a NAT gateway.  Routing to `private` subnets in those availability zones works as above.  However, all remaining availability zones will have their `private` subnets routed to in a round-robin fashion from the availability zones with NAT gateways.  While this can save money, it also introduces higher risk as failure of one availability zone may impact others.

### Security Groups

All traffic in and out of a VPC is controlled by [Security Groups](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_SecurityGroups.html).  Security groups can control incoming traffic through `ingress` rules and outgoing traffic through `egress` rules.  `ingress` and `egress` can be customized like so:

```ts
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const vpc = new awsx.ec2.Vpc("custom", {
   // ...
});

const sg = new awsx.ec2.SecurityGroup("custom", { vpc });
awsx.ec2.SecurityGroupRule.ingress("https-access", sg,
   new awsx.ec2.AnyIPv4Location(),
   new awsx.ec2.TcpPorts(443),
   "allow https access");
awsx.ec2.SecurityGroupRule.ingress("ssd-access", sg,
   new awsx.ec2.AnyIPv4Location(),
   new awsx.ec2.TcpPorts(22),
   "allow ssh access");
```

For detailed reference documentation, please visit [the API docs](
https://pulumi.io/reference/pkg/nodejs/@pulumi/awsx/ec2/).
