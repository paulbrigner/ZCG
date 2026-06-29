#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ZcgPrototypeStack } from "./zcg-prototype-stack";

const app = new cdk.App();

new ZcgPrototypeStack(app, "ZcgPrototypeStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1"
  }
});
