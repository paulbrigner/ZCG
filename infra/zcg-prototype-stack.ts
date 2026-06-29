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

export class ZcgPrototypeStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const appName = this.node.tryGetContext("appName") ?? "zcg-prototype";
    const environmentName = this.node.tryGetContext("environment") ?? "prototype";
    const betterAuthUrl = this.node.tryGetContext("betterAuthUrl");
    const bootstrapAdminEmails = this.node.tryGetContext("bootstrapAdminEmails") ?? "";
    const enableDeletionProtection = this.node.tryGetContext("deletionProtection") === "true";
    const removalPolicy =
      this.node.tryGetContext("removalPolicy") === "destroy"
        ? RemovalPolicy.DESTROY
        : RemovalPolicy.RETAIN;

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1
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
        version: rds.AuroraPostgresEngineVersion.of("16.6", "16")
      }),
      writer: rds.ClusterInstance.serverlessV2("writer", {
        publiclyAccessible: false
      }),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: Number(this.node.tryGetContext("dbMaxAcu") ?? 2),
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

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED
    });

    const appLogGroup = new logs.LogGroup(this, "AppLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy
    });

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "WebService", {
      cluster,
      cpu: Number(this.node.tryGetContext("webCpu") ?? 512),
      desiredCount: Number(this.node.tryGetContext("webDesiredCount") ?? 1),
      memoryLimitMiB: Number(this.node.tryGetContext("webMemoryMiB") ?? 1024),
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
        environment: {
          APP_ENV: environmentName,
          NEXT_PUBLIC_APP_NAME: "ZCG Grants Prototype",
          DB_HOST: database.clusterEndpoint.hostname,
          DB_PORT: "5432",
          DB_NAME: "zcg",
          DB_SSL: "false",
          SNAPSHOT_BUCKET_NAME: snapshotBucket.bucketName,
          BOOTSTRAP_ADMIN_EMAILS: bootstrapAdminEmails
        },
        secrets: {
          DB_USER: ecs.Secret.fromSecretsManager(database.secret!, "username"),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, "password"),
          BETTER_AUTH_SECRET: ecs.Secret.fromSecretsManager(betterAuthSecret, "secret")
        }
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

    service.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: ["*"]
      })
    );

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
      ZCG_GOOGLE_SHEET_ID:
        this.node.tryGetContext("googleSheetId") ?? "1FQ28rDCyRW0TiNxrm3rgD8ai2KGUsXAjPieQmI1kKKg",
      ZCG_GOOGLE_SHEET_TABS: this.node.tryGetContext("googleSheetTabs") ?? "default:803214474"
    };

    const syncWorkerLogGroup = new logs.LogGroup(this, "SyncWorkerLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy
    });

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

    const migrationRunnerLogGroup = new logs.LogGroup(this, "MigrationRunnerLogGroup", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy
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

    syncWorker.metricErrors().createAlarm(this, "SyncWorkerErrorsAlarm", {
      alarmName: `${appName}-${environmentName}-sync-worker-errors`,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
    });

    new cloudwatch.Alarm(this, "WebTarget5xxAlarm", {
      alarmName: `${appName}-${environmentName}-web-5xx`,
      metric: service.targetGroup.metrics.httpCodeTarget(
        elbv2.HttpCodeTarget.TARGET_5XX_COUNT
      ),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD
    });

    new cdk.CfnOutput(this, "AppUrl", {
      value: `http://${service.loadBalancer.loadBalancerDnsName}`
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
      value: syncWorker.functionName
    });
    new cdk.CfnOutput(this, "MigrationRunnerFunctionName", {
      value: migrationRunner.functionName
    });
  }
}
