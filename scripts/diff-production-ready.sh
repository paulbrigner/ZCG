#!/usr/bin/env bash
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-zodldashboard}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SES_FROM_EMAIL="${SES_FROM_EMAIL:-no-reply@pgpz.org}"
GITHUB_TOKEN_SECRET_ID="${GITHUB_TOKEN_SECRET_ID:-zcg/prototype/github-mirror-token}"
export AWS_PROFILE AWS_REGION

npm run infra:diff -- \
  -c costMode=production-ready \
  -c environment=prototype \
  -c removalPolicy=retain \
  -c deletionProtection=true \
  -c sesFromEmail="$SES_FROM_EMAIL" \
  -c githubTokenSecretId="$GITHUB_TOKEN_SECRET_ID" \
  "$@"
