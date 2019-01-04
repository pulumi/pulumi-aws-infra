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

import * as pulumi from "@pulumi/pulumi";

import * as aws from "@pulumi/aws";
import * as awsinfra from "@pulumi/aws-infra";
const x = awsinfra.x;

import { Config, Output } from "@pulumi/pulumi";

const vpc = x.ec2.Vpc.getDefault();
const cluster = new x.ecs.Cluster("testing", { vpc });

// A simple NGINX service, scaled out over two containers.
const nginxListener = new x.elasticloadbalancingv2.NetworkListener("examples-nginx", { port: 80 });
const nginx = new x.ecs.FargateService("examples-nginx", {
    cluster,
    taskDefinitionArgs: {
        containers: {
            nginx: {
                image: "nginx",
                memory: 128,
                portMappings: nginxListener,
            },
        },
    },
    desiredCount: 2,
});

const nginxEndpoint = nginxListener.endpoint();

// A simple NGINX service, scaled out over two containers, starting with a task definition.
const simpleNginxListener = new x.elasticloadbalancingv2.NetworkListener("examples-simple-nginx", { port: 80 });
const simpleNginx = new x.ecs.FargateTaskDefinition("examples-simple-nginx", {
    container: {
        image: "nginx",
        memory: 128,
        portMappings: simpleNginxListener,
    },
}).createService("examples-simple-nginx", { cluster, desiredCount: 2});

const simpleNginxEndpoint = simpleNginxListener.endpoint();

const cachedNginx = new x.ecs.FargateService("examples-cached-nginx", {
    cluster,
    taskDefinitionArgs: {
        containers: {
            nginx: {
                image: x.ecs.Image.fromDockerBuild({
                    context: "./app",
                    cacheFrom: true,
                }),
                memory: 128,
                portMappings: new x.elasticloadbalancingv2.NetworkListener("examples-cached-nginx", { port: 80 }),
            },
        },
    },
    desiredCount: 2,
});

const multistageCachedNginx = new x.ecs.FargateService("examples-multistage-cached-nginx", {
    cluster,
    taskDefinitionArgs: {
        containers: {
            nginx: {
                image: x.ecs.Image.fromDockerBuild({
                    context: "./app",
                    dockerfile: "./app/Dockerfile-multistage",
                    cacheFrom: {stages: ["build"]},
                }),
                memory: 128,
                portMappings: new x.elasticloadbalancingv2.NetworkListener(
                    "examples-multistage-cached-nginx", { port: 80 }),
            },
        },
    },
    desiredCount: 2,
});

const customWebServerListener =
    new x.elasticloadbalancingv2.NetworkTargetGroup("custom", { port: 8080 })
         .createListener("custom", { port: 80 });

const customWebServer = new x.ecs.FargateService("mycustomservice", {
    cluster,
    taskDefinitionArgs: {
        containers: {
            webserver: {
                memory: 128,
                portMappings: customWebServerListener,
                image: x.ecs.Image.fromFunction(() => {
                    const rand = Math.random();
                    const http = require("http");
                    http.createServer((req: any, res: any) => {
                        res.end(`Hello, world! (from ${rand})`);
                    }).listen(8080);
                }),
            },
        },
    },
    desiredCount: 2,
});

const config = new Config("containers");
const redisPassword = config.require("redisPassword");

/**
 * A simple Cache abstration, built on top of a Redis container Service.
 */
class Cache {
    get: (key: string) => Promise<string>;
    set: (key: string, value: string) => Promise<void>;

    constructor(name: string, memory: number = 128) {
        const redisListener = new x.elasticloadbalancingv2.NetworkListener(name, { port: 6379 });
        const redis = new x.ecs.FargateService(name, {
            cluster,
            taskDefinitionArgs: {
                containers: {
                    redis: {
                        image: "redis:alpine",
                        memory: memory,
                        portMappings: redisListener,
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

const cache = new Cache("examples-mycache");

const helloTask = new x.ecs.FargateTaskDefinition("examples-hello-world", {
    container: {
        image: "hello-world",
        memory: 20,
    },
});

// build an anonymous image:
const builtServiceListener = new x.elasticloadbalancingv2.NetworkListener("examples-nginx2", { port: 80 });
const builtService = new x.ecs.FargateService("examples-nginx2", {
    cluster,
    taskDefinitionArgs: {
        containers: {
            nginx: {
                image: x.ecs.Image.fromPath("./app"),
                memory: 128,
                portMappings: builtServiceListener,
            },
        },
    },
    desiredCount: 2,
    waitForSteadyState: false,
});

function errorJSON(err: any) {
    const result: any = Object.create(null);
    Object.getOwnPropertyNames(err).forEach(key => result[key] = err[key]);
    result.florp = "blopr";
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
const api = new aws.apigateway.x.API("examples-containers", {
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
        eventHandler: new aws.lambda.CallbackFunction("runRoute", {
            policies: [...x.ecs.TaskDefinition.defaultTaskRolePolicyARNs()],
            callback: async (req) => {
                try {
                    const result = await helloTask.run({ cluster });
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
            const endpoint = customWebServerListener.endpoint().get();
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
export let publicSubnets = vpc.publicSubnetIds;
export let privateSubnets = vpc.privateSubnetIds;
export let isolatedSubnets = vpc.isolatedSubnetIds;
