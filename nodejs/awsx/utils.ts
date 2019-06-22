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

import * as deasync from "deasync";

import * as crypto from "crypto";

type Diff<T extends string | number | symbol, U extends string | number | symbol> =
  ({ [P in T]: P } & { [P in U]: never } & { [x: string]: never })[T];

// Overwrite allows you to take an existing type, and then overwrite existing properties in it
// with properties of the same name, but with entirely different types.
export type Overwrite<T, U> = Pick<T, Diff<keyof T, keyof U>> & U;

/** @internal */
export type Mutable<T> = {
    -readonly [P in keyof T]: T[P];
};

// sha1hash returns a partial SHA1 hash of the input string.
/** @internal */
export function sha1hash(s: string): string {
    const shasum: crypto.Hash = crypto.createHash("sha1");
    shasum.update(s);
    // TODO[pulumi/pulumi#377] Workaround for issue with long names not generating per-deplioyment randomness, leading
    //     to collisions.  For now, limit the size of hashes to ensure we generate shorter/ resource names.
    return shasum.digest("hex").substring(0, 8);
}

/** @internal */
export function combineArrays<T>(
    e1: pulumi.Input<T[] | undefined>,
    e2: pulumi.Input<T[] | undefined>): pulumi.Output<T[]> {

    const result = pulumi.all([e1, e2]).apply(([e1, e2]) => {
        e1 = e1 || [];
        e2 = e2 || [];
        return [...e1, ...e2];
    });

    return <pulumi.Output<T[]>><unknown>result;
}

type WithoutUndefined<T> = T extends undefined ? never : T;

/** @internal */
export function ifUndefined<T>(input: pulumi.Input<T> | undefined, value: pulumi.Input<T>): pulumi.Output<WithoutUndefined<T>> {
    return <any>pulumi.all([input, value])
                      .apply(([input, value]) => input !== undefined ? input : value);
}

/** @internal */
export type Compatible<T, U> = T extends U ? U extends T ? any : void : void;

/** @internal */
export function checkCompat<T, U>(): Compatible<T, U> {
    return undefined!;
}

/** @internal */
export function mergeTags(tags1: pulumi.Input<aws.Tags> | undefined,
                          tags2: pulumi.Input<aws.Tags> | undefined): pulumi.Output<aws.Tags> {
    return pulumi.all([tags1, tags2]).apply(([tags1, tags2]) => ({
        ...(tags1 || {}),
        ...(tags2 || {}),
    }));
}

/**
 * Common code for doing RTTI typechecks.  RTTI is done by having a boolean property on an object
 * with a special name (like "__resource" or "__asset").  This function checks that the object
 * exists, has a **boolean** property with that name, and that that boolean property has the value
 * of 'true'.  Checking that property is 'boolean' helps ensure that this test works even on proxies
 * that synthesize properties dynamically (like Output).  Checking that the property has the 'true'
 * value isn't strictly necessary, but works to make sure that the impls are following a common
 * pattern.
 */
/** @internal */
export function isInstance<T>(obj: any, name: keyof T): obj is T {
    return hasTrueBooleanMember(obj, name);
}

/** @internal */
export function hasTrueBooleanMember(obj: any, memberName: string | number | symbol): boolean {
    if (obj === undefined || obj === null) {
        return false;
    }

    const val = obj[memberName];
    if (typeof val !== "boolean") {
        return false;
    }

    return val === true;
}

/** @internal */
export function getRegionFromOpts(opts: pulumi.CustomResourceOptions): pulumi.Output<aws.Region> {
    if (opts.parent) {
        return getRegion(opts.parent);
    }

    return getRegionFromProvider(opts.provider);
}


/** @internal */
export function getRegion(res: pulumi.Resource): pulumi.Output<aws.Region> {
    // A little strange, but all we're doing is passing a fake type-token simply to get
    // the AWS provider from this resource.
    return getRegionFromProvider(res.getProvider("aws::"));
}

function getRegionFromProvider(provider: pulumi.ProviderResource | undefined) {
    const region = provider ? (<any>provider).region : undefined;
    return region || aws.config.region;
}

/** @internal */
export function promiseResult<T>(promise: Promise<T>): T {
    enum State {
        running,
        finishedSuccessfully,
        finishedWithError,
    }

    let result: T;
    let error = undefined;
    let state = <State>State.running;

    promise.then(
        val => {
            result = val;
            state = State.finishedSuccessfully;
        },
        err => {
            error = err;
            state = State.finishedWithError;
        });

    deasync.loopWhile(() => state === State.running);
    if (state === State.finishedWithError) {
        throw error;
    }

    return result!;
}

interface HasAliases { aliases?: pulumi.Input<pulumi.URN | pulumi.Alias>[]; }

/** @internal */
export function withAlias<T extends HasAliases>(opts: T, alias: pulumi.Input<pulumi.URN | pulumi.Alias>): T {
  return withAliases(opts, [alias]);
}

/** @internal */
export function withAliases<T extends HasAliases>(opts: T, aliases: pulumi.Input<pulumi.URN | pulumi.Alias>[]): T {
    const allAliases: pulumi.Input<pulumi.URN | pulumi.Alias>[] = [];
    if (opts.aliases) {
        for (const alias of opts.aliases) {
            allAliases.push(alias);
        }
    }

    for (const alias of aliases) {
        allAliases.push(alias);
    }

    return { ...opts, aliases };
}
