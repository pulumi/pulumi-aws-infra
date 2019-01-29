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
import * as awsx from "@pulumi/awsx";

const vpcWithDifferentCidrBlock = new awsx.ec2.Vpc("custom1", {
    cidrBlock: "192.168.0.0/16",
});

const vpcWithOnlyPublicSubnets = new awsx.ec2.Vpc("custom2", {
    cidrBlock: "193.168.0.0/16",
    subnets: [{
        type: "public"
    }]
});

const vpcWithOnlyPrivateSubnets = new awsx.ec2.Vpc("custom3", {
    cidrBlock: "194.168.0.0/16",
    subnets: [{
        type: "private"
    }]
});
