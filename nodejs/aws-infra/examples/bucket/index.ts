// Copyright 2016-2017, Pulumi Corporation.  All rights reserved.

import * as aws from "@pulumi/aws";
import * as awsinfra from "@pulumi/aws-infra";
import * as pulumi from "@pulumi/pulumi";
import { Output } from "@pulumi/pulumi";

const bucket = new aws.s3.Bucket("testbucket", {
    serverSideEncryptionConfiguration: {
        rule: {
            applyServerSideEncryptionByDefault: {
                sseAlgorithm: "AES256",
            },
        },
    },
    forceDestroy: true,
}, { parent: this  });

awsinfra.serverless.bucket.onPut("test", bucket, async (event) => {
    const awssdk = await import("aws-sdk");
    const s3 = new awssdk.S3();

    const records = event.Records || [];
    for (const record of records) {
        // Construct an event arguments object.
        const args = {
            key: record.s3.object.key,
            size: record.s3.object.size,
            eventTime: record.eventTime,
        };

        const res = await s3.putObject({
            Bucket: bucket.id.get(),
            Key: "file.json",
            Body: JSON.stringify(args),
        }).promise();
    }
}, {});
