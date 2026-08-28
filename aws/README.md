# AWS access for the Cluster App deploy user

Three customer-managed policies, attached to one programmatic IAM user.
Together they allow building, deploying, and operating **this project** —
and nothing else in the account.

| File | Policy name | Covers |
|---|---|---|
| `01-compute.json` | `ClusterAppCompute` | ECR, ECS, Elastic Load Balancing, EC2 networking + small instances, EBS/DLM snapshots, Application Auto Scaling |
| `02-data-and-edge.json` | `ClusterAppDataEdge` | S3, DynamoDB, Cognito, Secrets Manager, SSM Parameter Store, CloudWatch + Logs, ACM, Route 53 records |
| `03-iam-scoped.json` | `ClusterAppIam` | Creating/passing **project-prefixed roles only**, plus explicit guardrails |

## Setup (client, ~5 minutes)

```bash
aws iam create-policy --policy-name ClusterAppCompute  --policy-document file://01-compute.json
aws iam create-policy --policy-name ClusterAppDataEdge --policy-document file://02-data-and-edge.json
aws iam create-policy --policy-name ClusterAppIam      --policy-document file://03-iam-scoped.json

aws iam create-user --user-name cluster-app-deploy

for P in ClusterAppCompute ClusterAppDataEdge ClusterAppIam; do
  aws iam attach-user-policy --user-name cluster-app-deploy \
    --policy-arn arn:aws:iam::174171641416:policy/$P
done

aws iam create-access-key --user-name cluster-app-deploy
```

Or in the console: IAM → Policies → Create policy → JSON tab → paste each
file → IAM → Users → Create user (**no** console access) → attach all three.

Send the access key over 1Password or Bitwarden Send — not email or Slack.
The secret is displayed once and cannot be retrieved afterwards.

## Naming requirement

Resource scoping is by name prefix. Anything created outside these prefixes
will fail with `AccessDenied`:

- IAM roles → `ClusterApp*` or `cluster-app-*`
- ECS cluster / services / task definitions → `cluster-app*`
- ECR repositories → `cluster-app*` or `profile-card*`
- S3 buckets → `cluster-app-*` or `profile-card-*`
- DynamoDB tables → `ProfileEntries` or `ClusterApp*`
- EC2 instance profiles → `ClusterApp*`
- Secrets → `cluster-app/*` · SSM parameters → `/cluster-app/*`

The two task roles must therefore be `ClusterAppTaskRole` and
`ClusterAppTaskExecutionRole` — `iam:PassRole` is granted on those prefixes
only, and only to `ecs-tasks`, `ecs`, `application-autoscaling`, `lambda`,
`events`, `ec2` (the MongoDB host's SSM role), and `dlm` (snapshots).

## What this user explicitly cannot do

These are hard `Deny` statements, which override any `Allow`:

- **No IAM identities** — cannot create users, groups, access keys, login
  profiles, MFA devices, or identity providers; cannot touch any role
  outside the project prefixes
- **No privilege escalation** — cannot attach `AdministratorAccess`,
  `PowerUserAccess`, or `IAMFullAccess` to anything
- **No large or reserved compute** — instance launches are capped by an
  `ec2:InstanceType` condition to `t4g.micro/small/medium` and
  `t3.micro/small/medium`. Cannot buy reserved instances or capacity
  blocks, or create VPC peering. This is the control that actually bounds
  the bill: the biggest thing this user can start costs about $30/month
- **No account control** — cannot touch Organizations, billing, budgets,
  account settings, or Route 53 *hosted zones* and domain registration
  (record changes within existing zones are allowed, for ACM validation
  and the ALB alias)
- **No covering tracks** — cannot delete, stop, or modify CloudTrail,
  GuardDuty, or AWS Config

## Verify after setup

```bash
aws configure --profile clusterapp
aws sts get-caller-identity --profile clusterapp   # must return 174171641416
```

## Optional hardening

For a client who wants a formal guarantee rather than prefix conventions,
add a **permissions boundary**: create a policy capping what any role this
user creates may do, then add a condition to `ManageProjectRolesOnly` in
`03-iam-scoped.json` requiring `iam:PermissionsBoundary` to equal its ARN.
That makes role-based escalation structurally impossible instead of
merely denied case-by-case.

---

# GitHub Actions deploy role (CI/CD)

`04-github-oidc-deploy.json` → policy `ClusterAppGitHubDeploy`, attached to
role **`ClusterAppGitHubDeployRole`**. This is what
`.github/workflows/deploy.yml` assumes to ship a release.

**There is no access key.** The role is assumed through GitHub's OIDC
identity provider, so GitHub holds no AWS credential — nothing to store as a
repository secret, nothing to rotate, nothing to leak. The trust policy
accepts a token only when both of these hold:

- `aud` is `sts.amazonaws.com`, and
- `sub` is `repo:cristian-gu/Cluster_app:ref:refs/heads/main`
  or `repo:cristian-gu/Cluster_app:environment:production`

A fork, a pull request, a different branch, or another repository entirely
cannot assume it. The second `sub` is pre-authorised so that adding a
GitHub **Environment** named `production` (for a manual approval gate) works
without touching IAM again.

## What the role may do

| | |
|---|---|
| ECR | push/pull **only** `cluster-app`; `GetAuthorizationToken` (this action has no resource-level form, so it is granted on `*`) |
| ECS | register a task definition, and update **only** `service/cluster-app/cluster-app`; read tasks in that cluster to wait out the rollout |
| IAM | `PassRole` on `ClusterAppTaskRole` and `ClusterAppTaskExecutionRole`, and only to `ecs-tasks.amazonaws.com` |

`ecs:RegisterTaskDefinition` and `ecs:DescribeTaskDefinition` have no
resource-level permissions in IAM and must be granted on `*`. The `PassRole`
statement is the real constraint: a task definition is only useful if it can
carry a role, and those are the only two roles this identity can attach.

An explicit `Deny` blocks `CreateUser`, `CreateAccessKey`,
`AttachRolePolicy`, `AttachUserPolicy`, `PutRolePolicy`,
`UpdateAssumeRolePolicy` and `DeleteRolePermissionsBoundary`, so the role
cannot widen its own permissions. Verified with the policy simulator: every
action the pipeline performs is `allowed`; `iam:CreateAccessKey` and
`iam:AttachRolePolicy` are `explicitDeny`; `ec2:TerminateInstances`,
`s3:DeleteBucket` and `ecs:DeleteCluster` are `implicitDeny`.

## Recreating it from scratch

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 \
                    1c58a3a8518e8759bf075b76b750d4f2df264fcd

aws iam create-role --role-name ClusterAppGitHubDeployRole \
  --assume-role-policy-document file://05-github-oidc-trust.json \
  --max-session-duration 3600

aws iam create-policy --policy-name ClusterAppGitHubDeploy \
  --policy-document file://04-github-oidc-deploy.json

aws iam attach-role-policy --role-name ClusterAppGitHubDeployRole \
  --policy-arn arn:aws:iam::174171641416:policy/ClusterAppGitHubDeploy
```

> The `cluster-app-deploy` IAM **user** documented above is now only needed
> for operator work from a laptop. Routine deploys go through the OIDC role
> and need no long-lived key at all.
