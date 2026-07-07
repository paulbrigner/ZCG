import path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

type CostMode = "prototype-low-cost" | "production-ready";

function contextBoolean(
  scope: Construct,
  key: string,
  defaultValue: boolean
): boolean {
  const value = scope.node.tryGetContext(key);

  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (value === true || value === "true") {
    return true;
  }

  if (value === false || value === "false") {
    return false;
  }

  throw new Error(`Context value ${key} must be true or false.`);
}

function contextNumber(scope: Construct, key: string, defaultValue: number): number {
  const value = scope.node.tryGetContext(key);

  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Context value ${key} must be a number.`);
  }

  return parsed;
}

function logRetentionForDays(days: number): logs.RetentionDays {
  const retentionByDays = new Map<number, logs.RetentionDays>([
    [1, logs.RetentionDays.ONE_DAY],
    [3, logs.RetentionDays.THREE_DAYS],
    [5, logs.RetentionDays.FIVE_DAYS],
    [7, logs.RetentionDays.ONE_WEEK],
    [14, logs.RetentionDays.TWO_WEEKS],
    [30, logs.RetentionDays.ONE_MONTH],
    [60, logs.RetentionDays.TWO_MONTHS],
    [90, logs.RetentionDays.THREE_MONTHS]
  ]);
  const retention = retentionByDays.get(days);

  if (!retention) {
    throw new Error("Context value logRetentionDays must be one of 1, 3, 5, 7, 14, 30, 60, or 90.");
  }

  return retention;
}

export class ZcgPrototypeStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const appName = this.node.tryGetContext("appName") ?? "zcg-prototype";
    const environmentName = this.node.tryGetContext("environment") ?? "prototype";
    const costModeContext = this.node.tryGetContext("costMode") ?? "production-ready";

    if (costModeContext !== "prototype-low-cost" && costModeContext !== "production-ready") {
      throw new Error("Context value costMode must be prototype-low-cost or production-ready.");
    }

    const costMode = costModeContext as CostMode;
    const isPrototypeLowCost = costMode === "prototype-low-cost";
    const betterAuthUrl = this.node.tryGetContext("betterAuthUrl");
    const bootstrapAdminEmails = this.node.tryGetContext("bootstrapAdminEmails") ?? "";
    const sesFromEmail = this.node.tryGetContext("sesFromEmail") as string | undefined;
    const sesIdentityName =
      (this.node.tryGetContext("sesIdentityName") as string | undefined) ??
      sesFromEmail?.split("@").at(-1);
    const enableDeletionProtection = this.node.tryGetContext("deletionProtection") === "true";
    const removalPolicy =
      this.node.tryGetContext("removalPolicy") === "destroy"
        ? RemovalPolicy.DESTROY
        : RemovalPolicy.RETAIN;
    const enableWebService = contextBoolean(this, "enableWebService", !isPrototypeLowCost);
    const enableAlb = contextBoolean(this, "enableAlb", true);
    const enableWorkers = contextBoolean(this, "enableWorkers", true);
    const enableAlarms = contextBoolean(this, "enableAlarms", !isPrototypeLowCost);
    const enableContainerInsights = contextBoolean(this, "containerInsights", !isPrototypeLowCost);
    const natGateways = contextNumber(this, "natGateways", enableWorkers ? 1 : 0);
    const dbMinAcu = contextNumber(this, "dbMinAcu", isPrototypeLowCost ? 0 : 0.5);
    const dbMaxAcu = contextNumber(this, "dbMaxAcu", isPrototypeLowCost ? 1 : 2);
    const dbAutoPauseSeconds = contextNumber(this, "dbAutoPauseSeconds", 15 * 60);
    const logRetentionDays = contextNumber(this, "logRetentionDays", isPrototypeLowCost ? 7 : 30);
    const logRetention = logRetentionForDays(logRetentionDays);

    if (dbMinAcu === 0 && (dbAutoPauseSeconds < 300 || dbAutoPauseSeconds > 86400)) {
      throw new Error("Context value dbAutoPauseSeconds must be between 300 and 86400 when dbMinAcu=0.");
    }

    if (enableWorkers && natGateways === 0) {
      throw new Error(
        "natGateways=0 is not safe while enableWorkers=true because sync workers need public internet access for GitHub and Google Sheet mirroring. Disable workers or keep NAT until workers use Data API/out-of-VPC egress."
      );
    }

    cdk.Tags.of(this).add("Project", "ZCG");
    cdk.Tags.of(this).add("Environment", environmentName);
    cdk.Tags.of(this).add("Application", "zcg");
    cdk.Tags.of(this).add("Repository", "paulbrigner/ZCG");
    cdk.Tags.of(this).add("ManagedBy", "Codex");
    cdk.Tags.of(this).add("CostMode", costMode);

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways
    });

    const snapshotBucket = new s3.Bucket(this, "SnapshotBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy,
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY
    });

    const betterAuthSecret = new secretsmanager.Secret(this, "BetterAuthSecret", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "secret",
        passwordLength: 48,
        excludePunctuation: true
      }
    });

    const database = new rds.DatabaseCluster(this, "Database", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.of("16.13", "16")
      }),
      writer: rds.ClusterInstance.serverlessV2("writer", {
        publiclyAccessible: false
      }),
      serverlessV2MinCapacity: dbMinAcu,
      serverlessV2MaxCapacity: dbMaxAcu,
      serverlessV2AutoPauseDuration:
        dbMinAcu === 0 ? Duration.seconds(dbAutoPauseSeconds) : undefined,
      credentials: rds.Credentials.fromGeneratedSecret("zcg_admin"),
      defaultDatabaseName: "zcg",
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      backup: {
        retention: Duration.days(7)
      },
      deletionProtection: enableDeletionProtection,
      removalPolicy,
      cloudwatchLogsExports: ["postgresql"],
      enableDataApi: true
    });

    const amplifyComputeRole = new iam.Role(this, "AmplifyComputeRole", {
      assumedBy: new iam.ServicePrincipal("amplify.amazonaws.com"),
      description: "SSR compute role for the ZCG Amplify web tier to call the RDS Data API."
    });

    amplifyComputeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "rds-data:ExecuteStatement",
          "rds-data:BatchExecuteStatement",
          "rds-data:BeginTransaction",
          "rds-data:CommitTransaction",
          "rds-data:RollbackTransaction"
        ],
        resources: [database.clusterArn]
      })
    );
    database.secret!.grantRead(amplifyComputeRole);

    if (sesFromEmail && sesIdentityName) {
      amplifyComputeRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["ses:SendEmail", "ses:SendRawEmail"],
          resources: [
            this.formatArn({
              service: "ses",
              resource: "identity",
              resourceName: sesIdentityName
            })
          ]
        })
      );
    }

    const appLogGroup = new logs.LogGroup(this, "AppLogGroup", {
      retention: logRetention,
      removalPolicy
    });

    let appUrl = "Amplify/Data API web tier; ECS web service disabled";
    let webClusterName = "disabled";
    let webServiceName = "disabled";
    let webServiceDesiredCount = 0;
    let webTargetGroup: elbv2.ApplicationTargetGroup | undefined;

    const webCpu = contextNumber(this, "webCpu", 512);
    const webMemoryMiB = contextNumber(this, "webMemoryMiB", 1024);
    const requestedWebDesiredCount = contextNumber(this, "webDesiredCount", isPrototypeLowCost ? 0 : 1);
    const appEnvironment = {
      APP_ENV: environmentName,
      NEXT_PUBLIC_APP_NAME: "ZCG Grants Prototype",
      DB_HOST: database.clusterEndpoint.hostname,
      DB_PORT: "5432",
      DB_NAME: "zcg",
      DB_SSL: "false",
      SNAPSHOT_BUCKET_NAME: snapshotBucket.bucketName,
      BOOTSTRAP_ADMIN_EMAILS: bootstrapAdminEmails,
      ...(sesFromEmail ? { SES_FROM_EMAIL: sesFromEmail } : {})
    };
    const appSecrets = {
      DB_USER: ecs.Secret.fromSecretsManager(database.secret!, "username"),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, "password"),
      BETTER_AUTH_SECRET: ecs.Secret.fromSecretsManager(betterAuthSecret, "secret")
    };

    if (enableWebService) {
      const cluster = new ecs.Cluster(this, "Cluster", {
        vpc,
        containerInsightsV2: enableContainerInsights
          ? ecs.ContainerInsights.ENABLED
          : ecs.ContainerInsights.DISABLED
      });

      webClusterName = cluster.clusterName;
      webServiceDesiredCount = requestedWebDesiredCount;

      if (enableAlb) {
        const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "WebService", {
          cluster,
          cpu: webCpu,
          desiredCount: webServiceDesiredCount,
          memoryLimitMiB: webMemoryMiB,
          runtimePlatform: {
            cpuArchitecture: ecs.CpuArchitecture.X86_64,
            operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
          },
          publicLoadBalancer: true,
          assignPublicIp: false,
          circuitBreaker: {
            rollback: true
          },
          minHealthyPercent: 100,
          taskImageOptions: {
            image: ecs.ContainerImage.fromAsset(path.join(__dirname, ".."), {
              platform: Platform.LINUX_AMD64
            }),
            containerPort: 3000,
            logDriver: ecs.LogDrivers.awsLogs({
              logGroup: appLogGroup,
              streamPrefix: appName
            }),
            environment: appEnvironment,
            secrets: appSecrets
          }
        });

        service.taskDefinition.defaultContainer?.addEnvironment(
          "BETTER_AUTH_URL",
          betterAuthUrl ?? `http://${service.loadBalancer.loadBalancerDnsName}`
        );

        service.targetGroup.configureHealthCheck({
          path: "/api/health",
          healthyHttpCodes: "200",
          interval: Duration.seconds(30)
        });

        database.connections.allowDefaultPortFrom(service.service);
        snapshotBucket.grantReadWrite(service.taskDefinition.taskRole);
        webTargetGroup = service.targetGroup;
        webServiceName = service.service.serviceName;
        appUrl = `http://${service.loadBalancer.loadBalancerDnsName}`;

        if (sesFromEmail && sesIdentityName) {
          service.taskDefinition.taskRole.addToPrincipalPolicy(
            new iam.PolicyStatement({
              actions: ["ses:SendEmail", "ses:SendRawEmail"],
              resources: [
                this.formatArn({
                  service: "ses",
                  resource: "identity",
                  resourceName: sesIdentityName
                })
              ]
            })
          );
        }
      } else {
        const webIngressCidr = this.node.tryGetContext("webIngressCidr") as string | undefined;

        if (!webIngressCidr) {
          throw new Error("enableAlb=false requires webIngressCidr so the public task ingress is explicit.");
        }

        const taskDefinition = new ecs.FargateTaskDefinition(this, "WebTaskDefinition", {
          cpu: webCpu,
          memoryLimitMiB: webMemoryMiB,
          runtimePlatform: {
            cpuArchitecture: ecs.CpuArchitecture.X86_64,
            operatingSystemFamily: ecs.OperatingSystemFamily.LINUX
          }
        });
        const container = taskDefinition.addContainer("AppContainer", {
          image: ecs.ContainerImage.fromAsset(path.join(__dirname, ".."), {
            platform: Platform.LINUX_AMD64
          }),
          logging: ecs.LogDrivers.awsLogs({
            logGroup: appLogGroup,
            streamPrefix: appName
          }),
          environment: {
            ...appEnvironment,
            BETTER_AUTH_URL: betterAuthUrl ?? "http://localhost:3000"
          },
          secrets: appSecrets
        });

        container.addPortMappings({ containerPort: 3000 });

        const webSecurityGroup = new ec2.SecurityGroup(this, "WebServiceSecurityGroup", {
          vpc,
          allowAllOutbound: true,
          description: "Security group for optional public-subnet ECS web task without an ALB."
        });
        webSecurityGroup.addIngressRule(
          ec2.Peer.ipv4(webIngressCidr),
          ec2.Port.tcp(3000),
          "Explicit prototype-only web ingress when ALB is disabled."
        );

        const service = new ecs.FargateService(this, "WebService", {
          cluster,
          taskDefinition,
          desiredCount: webServiceDesiredCount,
          assignPublicIp: true,
          vpcSubnets: {
            subnetType: ec2.SubnetType.PUBLIC
          },
          securityGroups: [webSecurityGroup],
          circuitBreaker: {
            rollback: true
          },
          minHealthyPercent: 100
        });

        database.connections.allowDefaultPortFrom(webSecurityGroup);
        snapshotBucket.grantReadWrite(taskDefinition.taskRole);
        webServiceName = service.serviceName;
        appUrl = "ECS task public IP; run scripts/ecs-public-task-url.sh after resume";

        if (sesFromEmail && sesIdentityName) {
          taskDefinition.taskRole.addToPrincipalPolicy(
            new iam.PolicyStatement({
              actions: ["ses:SendEmail", "ses:SendRawEmail"],
              resources: [
                this.formatArn({
                  service: "ses",
                  resource: "identity",
                  resourceName: sesIdentityName
                })
              ]
            })
          );
        }
      }
    }

    const workerSecurityGroup = new ec2.SecurityGroup(this, "WorkerSecurityGroup", {
      vpc,
      allowAllOutbound: true
    });
    database.connections.allowDefaultPortFrom(workerSecurityGroup);

    const workerEnvironment = {
      APP_ENV: environmentName,
      DB_HOST: database.clusterEndpoint.hostname,
      DB_PORT: "5432",
      DB_NAME: "zcg",
      DB_SECRET_ARN: database.secret!.secretArn,
      DB_SSL: "false",
      SNAPSHOT_BUCKET_NAME: snapshotBucket.bucketName,
      ZCG_GITHUB_OWNER: this.node.tryGetContext("githubOwner") ?? "ZcashCommunityGrants",
      ZCG_GITHUB_REPO: this.node.tryGetContext("githubRepo") ?? "zcashcommunitygrants",
      ZCG_GITHUB_MAX_PAGES: String(this.node.tryGetContext("githubMaxPages") ?? 10),
      ZCG_GITHUB_COMMENT_MAX_PAGES: String(this.node.tryGetContext("githubCommentMaxPages") ?? 10),
      ZCG_GOOGLE_SHEET_ID:
        this.node.tryGetContext("googleSheetId") ?? "1FQ28rDCyRW0TiNxrm3rgD8ai2KGUsXAjPieQmI1kKKg",
      ZCG_GOOGLE_SHEET_TABS:
        this.node.tryGetContext("googleSheetTabs") ?? "all_grants_tracking:1164534734,milestone_details:803214474"
    };

    const syncWorkerLogGroup = new logs.LogGroup(this, "SyncWorkerLogGroup", {
      retention: logRetention,
      removalPolicy
    });

    const migrationRunnerLogGroup = new logs.LogGroup(this, "MigrationRunnerLogGroup", {
      retention: logRetention,
      removalPolicy
    });

    let syncWorkerFunctionName = "disabled";
    let migrationRunnerFunctionName = "disabled";

    if (enableWorkers) {
      const syncWorker = new lambdaNodejs.NodejsFunction(this, "SyncWorker", {
        entry: path.join(__dirname, "..", "workers", "sync-worker.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_24_X,
        timeout: Duration.minutes(5),
        memorySize: 512,
        vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
        },
        securityGroups: [workerSecurityGroup],
        environment: workerEnvironment,
        logGroup: syncWorkerLogGroup,
        bundling: {
          externalModules: []
        }
      });

      const migrationRunner = new lambdaNodejs.NodejsFunction(this, "MigrationRunner", {
        entry: path.join(__dirname, "..", "workers", "migration-runner.ts"),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_24_X,
        timeout: Duration.minutes(5),
        memorySize: 512,
        vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
        },
        securityGroups: [workerSecurityGroup],
        environment: workerEnvironment,
        logGroup: migrationRunnerLogGroup,
        bundling: {
          externalModules: [],
          commandHooks: {
            beforeBundling() {
              return [];
            },
            beforeInstall() {
              return [];
            },
            afterBundling(inputDir: string, outputDir: string) {
              return [`cp -R ${inputDir}/migrations ${outputDir}/migrations`];
            }
          }
        }
      });

      syncWorkerFunctionName = syncWorker.functionName;
      migrationRunnerFunctionName = migrationRunner.functionName;
      snapshotBucket.grantReadWrite(syncWorker);
      snapshotBucket.grantReadWrite(migrationRunner);
      database.secret!.grantRead(syncWorker);
      database.secret!.grantRead(migrationRunner);
      database.connections.allowDefaultPortFrom(syncWorker);
      database.connections.allowDefaultPortFrom(migrationRunner);

      new events.Rule(this, "SyncSchedule", {
        enabled: false,
        schedule: events.Schedule.rate(Duration.hours(6)),
        targets: [new targets.LambdaFunction(syncWorker)]
      });

      if (enableAlarms) {
        syncWorker.metricErrors().createAlarm(this, "SyncWorkerErrorsAlarm", {
          alarmName: `${appName}-${environmentName}-sync-worker-errors`,
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
        });
      }
    }

    if (enableAlarms && webTargetGroup) {
      new cloudwatch.Alarm(this, "WebTarget5xxAlarm", {
        alarmName: `${appName}-${environmentName}-web-5xx`,
        metric: webTargetGroup.metrics.httpCodeTarget(
          elbv2.HttpCodeTarget.TARGET_5XX_COUNT
        ),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
      });
    }

    new cdk.CfnOutput(this, "AppUrl", {
      value: appUrl
    });
    new cdk.CfnOutput(this, "SnapshotBucketName", {
      value: snapshotBucket.bucketName
    });
    new cdk.CfnOutput(this, "DatabaseSecretArn", {
      value: database.secret!.secretArn
    });
    new cdk.CfnOutput(this, "DatabaseClusterArn", {
      value: database.clusterArn
    });
    new cdk.CfnOutput(this, "AmplifyComputeRoleArn", {
      value: amplifyComputeRole.roleArn
    });
    new cdk.CfnOutput(this, "SyncWorkerFunctionName", {
      value: syncWorkerFunctionName
    });
    new cdk.CfnOutput(this, "MigrationRunnerFunctionName", {
      value: migrationRunnerFunctionName
    });
    new cdk.CfnOutput(this, "CostMode", {
      value: costMode
    });
    new cdk.CfnOutput(this, "WebServiceEnabled", {
      value: String(enableWebService)
    });
    new cdk.CfnOutput(this, "WebServiceAlbEnabled", {
      value: String(enableWebService && enableAlb)
    });
    new cdk.CfnOutput(this, "WebServiceClusterName", {
      value: webClusterName
    });
    new cdk.CfnOutput(this, "WebServiceName", {
      value: webServiceName
    });
    new cdk.CfnOutput(this, "WebServiceDesiredCount", {
      value: String(webServiceDesiredCount)
    });
    new cdk.CfnOutput(this, "NatGatewayCount", {
      value: String(natGateways)
    });
    new cdk.CfnOutput(this, "AuroraMinAcu", {
      value: String(dbMinAcu)
    });
    new cdk.CfnOutput(this, "AuroraMaxAcu", {
      value: String(dbMaxAcu)
    });
    new cdk.CfnOutput(this, "AuroraAutoPauseSeconds", {
      value: dbMinAcu === 0 ? String(dbAutoPauseSeconds) : "disabled"
    });
    new cdk.CfnOutput(this, "LogRetentionDays", {
      value: String(logRetentionDays)
    });
  }
}
