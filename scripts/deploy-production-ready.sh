#!/usr/bin/env bash
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-zodldashboard}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SES_FROM_EMAIL="${SES_FROM_EMAIL:-no-reply@pgpz.org}"
GITHUB_TOKEN_SECRET_ID="${GITHUB_TOKEN_SECRET_ID:-zcg/prototype/github-mirror-token}"
KNOWLEDGE_EMBEDDING_API_SECRET_ID="${KNOWLEDGE_EMBEDDING_API_SECRET_ID:-zcg/prototype/venice-api-key}"
KNOWLEDGE_EMBEDDING_BATCH_SIZE="${KNOWLEDGE_EMBEDDING_BATCH_SIZE:-2}"
KNOWLEDGE_EMBEDDING_TIMEOUT_MS="${KNOWLEDGE_EMBEDDING_TIMEOUT_MS:-60000}"
FORUM_MAX_TOPICS="${FORUM_MAX_TOPICS:-2000}"
FORUM_MAX_POSTS_PER_TOPIC="${FORUM_MAX_POSTS_PER_TOPIC:-20}"
FORUM_MAX_CATEGORY_PAGES="${FORUM_MAX_CATEGORY_PAGES:-25}"
FORUM_FETCH_DELAY_MS="${FORUM_FETCH_DELAY_MS:-500}"
export AWS_PROFILE AWS_REGION

npm run infra:deploy -- \
  -c costMode=production-ready \
  -c environment=prototype \
  -c removalPolicy=retain \
  -c deletionProtection=true \
  -c sesFromEmail="$SES_FROM_EMAIL" \
  -c githubTokenSecretId="$GITHUB_TOKEN_SECRET_ID" \
  -c knowledgeEmbeddingApiSecretId="$KNOWLEDGE_EMBEDDING_API_SECRET_ID" \
  -c knowledgeEmbeddingBatchSize="$KNOWLEDGE_EMBEDDING_BATCH_SIZE" \
  -c knowledgeEmbeddingTimeoutMs="$KNOWLEDGE_EMBEDDING_TIMEOUT_MS" \
  -c forumMaxTopics="$FORUM_MAX_TOPICS" \
  -c forumMaxPostsPerTopic="$FORUM_MAX_POSTS_PER_TOPIC" \
  -c forumMaxCategoryPages="$FORUM_MAX_CATEGORY_PAGES" \
  -c forumFetchDelayMs="$FORUM_FETCH_DELAY_MS" \
  "$@"
