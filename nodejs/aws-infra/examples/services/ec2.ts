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
import * as awsx from "@pulumi/aws-infra";

import { Config } from "@pulumi/pulumi";

const vpc = awsx.ec2.Vpc.getDefault();
const cluster1 = new awsx.ecs.Cluster("ec2-testing-1", { vpc });
cluster1.createAutoScalingGroup("ec2-testing-1", {
    templateParameters: {
        minSize: 20,
    },
    launchConfigurationArgs: {
        instanceType: "t2.xlarge",
    },
});

// A simple NGINX service, scaled out over two containers.
const nginxListener = new awsx.elasticloadbalancingv2.NetworkListener("ec2-nginx", { port: 80 });
const nginx = new awsx.ecs.EC2Service("ec2-nginx", {
    cluster: cluster1,
    taskDefinitionArgs: {
        containers: {
            nginx: {
                image: "nginx",
                memory: 64,
                portMappings: [nginxListener],
            },
        },
    },
    desiredCount: 1,
});

const nginxEndpoint = nginxListener.endpoint();

// A simple NGINX service, scaled out over two containers, starting with a task definition.
const simpleNginxListener = new awsx.elasticloadbalancingv2.NetworkListener("ec2-simple-nginx", { port: 80 });
const simpleNginx = new awsx.ecs.EC2TaskDefinition("ec2-simple-nginx", {
    container: {
        image: "nginx",
        memory: 64,
        portMappings: [simpleNginxListener],
    },
}).createService("examples-simple-nginx", { cluster: cluster1, desiredCount: 1});

const simpleNginxEndpoint = simpleNginxListener.endpoint();

const cachedNginx = new awsx.ecs.EC2Service("ec2-cached-nginx", {
    cluster: cluster1,
    taskDefinitionArgs: {
        containers: {
            nginx: {
                image: awsx.ecs.Image.fromDockerBuild("ec2-cached-nginx", {
                    context: "./app",
                    cacheFrom: true,
                }),
                memory: 64,
                portMappings: [new awsx.elasticloadbalancingv2.NetworkListener(
                    "ec2-cached-nginx", { port: 80 })],
            },
        },
    },
    desiredCount: 1,
});

const multistageCachedNginx = new awsx.ecs.EC2Service("ec2-multistage-cached-nginx", {
    cluster: cluster1,
    taskDefinitionArgs: {
        containers: {
            nginx: {
                image: awsx.ecs.Image.fromDockerBuild("ec2-multistage-cached-nginx", {
                    context: "./app",
                    dockerfile: "./app/Dockerfile-multistage",
                    cacheFrom: {stages: ["build"]},
                }),
                memory: 64,
                portMappings: [new awsx.elasticloadbalancingv2.NetworkListener(
                    "ec2-multistage-cached-nginx", { port: 80 })],
            },
        },
    },
    desiredCount: 1,
});

const customWebServerListener =
    new awsx.elasticloadbalancingv2.NetworkTargetGroup("ec2-custom", { port: 8080 })
         .createListener("ec2-custom", { port: 80 });

const customWebServer = new awsx.ecs.EC2Service("ec2-custom", {
    cluster: cluster1,
    taskDefinitionArgs: {
        containers: {
            webserver: {
                memory: 64,
                portMappings: [customWebServerListener],
                image: awsx.ecs.Image.fromFunction(() => {
                    const rand = Math.random();
                    const http = require("http");
                    http.createServer((req: any, res: any) => {
                        res.end(`Hello, world! (from ${rand})`);
                    }).listen(8080);
                }),
            },
        },
    },
    desiredCount: 1,
});

const config = new Config("containers");
const redisPassword = config.require("redisPassword");

/**
 * A simple Cache abstration, built on top of a Redis container Service.
 */
class Ec2Cache {
    get: (key: string) => Promise<string>;
    set: (key: string, value: string) => Promise<void>;

    constructor(name: string, memory: number = 128) {
        const redisListener = new awsx.elasticloadbalancingv2.NetworkListener(name, { port: 6379 });
        const redis = new awsx.ecs.EC2Service(name, {
            cluster: cluster1,
            taskDefinitionArgs: {
                containers: {
                    redis: {
                        image: "redis:alpine",
                        memory: memory,
                        portMappings: [redisListener],
                        command: ["redis-server", "--requirepass", redisPassword],
                    },
                },
            },
        });

        this.get = (key: string) => {
            const endpoint = redisListener.endpoint().get();
            console.log(`Endpoint: ${JSON.stringify(endpoint)}`);
            const client = require("redis").createClient(
                endpoint.port,
                endpoint.hostname,
                { password: redisPassword },
            );
            console.log(client);
            return new Promise<string>((resolve, reject) => {
                client.get(key, (err: any, v: any) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(v);
                    }
                });
            });
        };
        this.set = (key: string, value: string) => {
            const endpoint = redisListener.endpoint().get();
            console.log(`Endpoint: ${JSON.stringify(endpoint)}`);
            const client = require("redis").createClient(
                endpoint.port,
                endpoint.hostname,
                { password: redisPassword },
            );
            console.log(client);
            return new Promise<void>((resolve, reject) => {
                client.set(key, value, (err: any, v: any) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        };
    }
}

const cache = new Ec2Cache("ec2-mycache");

const helloTask = new awsx.ecs.EC2TaskDefinition("ec2-hello-world", {
    container: {
        image: "hello-world",
        memory: 20,
    },
});

// build an anonymous image:
const builtServiceListener = new awsx.elasticloadbalancingv2.NetworkListener("ec2-nginx2", { port: 80 });
const builtService = new awsx.ecs.EC2Service("ec2-nginx2", {
    cluster: cluster1,
    taskDefinitionArgs: {
        containers: {
            nginx: {
                image: awsx.ecs.Image.fromPath("ec2-nginx2", "./app"),
                memory: 64,
                portMappings: [builtServiceListener],
            },
        },
    },
    desiredCount: 1,
    waitForSteadyState: false,
});

function errorJSON(err: any) {
    const result: any = Object.create(null);
    Object.getOwnPropertyNames(err).forEach(key => result[key] = err[key]);
    return result;
}

function handleError(err: Error) {
    console.error(errorJSON(err));
    return {
        statusCode: 500,
        body: JSON.stringify(errorJSON(err)),
    };
}

// expose some APIs meant for testing purposes.
const api = new aws.apigateway.x.API("ec2-containers", {
    routes: [{
        path: "/test",
        method: "GET",
        eventHandler: async (req) => {
            try {
                return {
                    statusCode: 200,
                    body: JSON.stringify({
                        nginx: nginxListener.endpoint().get(),
                        nginx2: builtServiceListener.endpoint().get(),
                    }),
                };
            } catch (err) {
                return handleError(err);
            }
        },
    }, {
        path: "/",
        method: "GET",
        eventHandler: async (req) => {
            try {
                const fetch = (await import("node-fetch")).default;
                // Use the NGINX or Redis Services to respond to the request.
                console.log("handling /");
                const page = await cache.get("page");
                if (page) {
                    return {
                        statusCode: 200,
                        headers: { "X-Powered-By": "redis" },
                        body: page,
                    };
                }

                const endpoint = nginxListener.endpoint().get();
                console.log(`got host and port: ${JSON.stringify(endpoint)}`);
                const resp = await fetch(`http://${endpoint.hostname}:${endpoint.port}/`);
                const buffer = await resp.buffer();
                console.log(buffer.toString());
                await cache.set("page", buffer.toString());

                return {
                    statusCode: 200,
                    headers: { "X-Powered-By": "nginx" },
                    body: buffer.toString(),
                };
            } catch (err) {
                return handleError(err);
            }
        },
    }, {
        path: "/run",
        method: "GET",
        eventHandler: new aws.lambda.CallbackFunction("ec2-runRoute", {
            policies: [...awsx.ecs.TaskDefinition.defaultTaskRolePolicyARNs()],
            callback: async (req) => {
                try {
                    const result = await helloTask.run({ cluster: cluster1 });
                    return {
                        statusCode: 200,
                        body: JSON.stringify({ success: true, tasks: result.tasks }),
                    };
                } catch (err) {
                    return handleError(err);
                }
            },
        }),
    }, {
        path: "/custom",
        method: "GET",
        eventHandler: async (req): Promise<aws.apigateway.x.Response> => {
            try {
                const fetch = (await import("node-fetch")).default;
                const endpoint = customWebServerListener.endpoint().get();
                console.log(`got host and port: ${JSON.stringify(endpoint)}`);
                const resp = await fetch(`http://${endpoint.hostname}:${endpoint.port}/`);
                const buffer = await resp.buffer();
                console.log(buffer.toString());
                await cache.set("page", buffer.toString());

                return {
                    statusCode: 200,
                    headers: { "X-Powered-By": "custom web server" },
                    body: buffer.toString(),
                };
            } catch (err) {
                return handleError(err);
            }
        },
    }, {
        path: "/nginx",
        target: nginxListener.endpoint(),
    }],
});

export let frontendURL = api.url;
export let vpcId = vpc.id;
export let publicSubnetIds = vpc.publicSubnetIds;
export let privateSubnetIds = vpc.privateSubnetIds;
export let isolatedSubnetIds = vpc.isolatedSubnetIds;
