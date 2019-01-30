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

import * as fargate from "./fargate";

export let frontendURL = fargate.frontendURL;
export let fargateVpcId = fargate.vpcId;
export let fargatePublicSubnets = fargate.publicSubnetIds;
export let fargatePrivateSubnets = fargate.privateSubnetIds;
export let fargateIsolatedSubnets = fargate.isolatedSubnetIds;
