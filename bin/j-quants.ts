#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { JQuantsStack } from '../lib/j-quants-stack';

const app = new cdk.App();
new JQuantsStack(app, 'JQuantsStack');
