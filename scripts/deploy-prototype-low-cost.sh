#!/usr/bin/env bash
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-zodldashboard}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SES_FROM_EMAIL="${SES_FROM_EMAIL:-no-reply@pgpz.org}"
export AWS_PROFILE AWS_REGION

npm run infra:deploy -- \
  -c costMode=prototype-low-cost \
  -c environment=prototype \
  -c removalPolicy=retain \
  -c deletionProtection=true \
  -c sesFromEmail="$SES_FROM_EMAIL" \
  "$@"
